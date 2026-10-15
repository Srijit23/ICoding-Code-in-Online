import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocket, WebSocketServer } from 'ws';
import { detectMainClasses, validateFiles, type SubmittedFile } from './validation.ts';

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const IMAGE = process.env.JAVA_SANDBOX_IMAGE || 'airjava-sandbox:21';
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.JAVA_TIMEOUT_MS || 10000), 1000), 60000);
const MAX_FILES = Number(process.env.JAVA_MAX_FILES || 40);
const MAX_SOURCE_BYTES = Number(process.env.JAVA_MAX_SOURCE_BYTES || 300000);
const MAX_OUTPUT_BYTES = Number(process.env.JAVA_MAX_OUTPUT_BYTES || 1000000);
const MEMORY = process.env.JAVA_MAX_MEMORY || '256m';
const CPU = String(process.env.JAVA_CPU_LIMIT || '1');
const PIDS = String(Number(process.env.JAVA_PIDS_LIMIT || 64));
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((item) => item.trim()).filter(Boolean));
const MAX_CONCURRENT_RUNS = 4;

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '400kb' }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'airjava-api', image: IMAGE }));
app.get('/api/config', (_req, res) => res.json({ javaVersion: '21', timeoutMs: TIMEOUT_MS, maxFiles: MAX_FILES, maxSourceBytes: MAX_SOURCE_BYTES }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request.' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 500000, perMessageDeflate: false });
let activeRuns = 0;

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

type Job = {
  id: string;
  workspace: string;
  compileName: string;
  runtimeName: string;
  proc: ChildProcessWithoutNullStreams | null;
  timer: NodeJS.Timeout | null;
  outputBytes: number;
  finished: boolean;
};

function send(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function isMainClass(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value);
}

function readArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((item) => typeof item !== 'string' || item.length > 1000)) {
    throw new Error('Program arguments must be up to 30 strings, each no longer than 1,000 characters.');
  }
  return value as string[];
}

function dockerBase(name: string, workspace: string): string[] {
  return [
    'run', '--rm', '--name', name,
    '--network', process.env.JAVA_NETWORK || 'none',
    '--memory', MEMORY, '--memory-swap', MEMORY, '--cpus', CPU, '--pids-limit', PIDS,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '10001:10001', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--mount', 'type=bind,source=' + workspace + ',target=/workspace',
    '--workdir', '/workspace', IMAGE
  ];
}

function parseDiagnostics(raw: string) {
  const diagnostics: Array<{ severity: string; file: string; line: number; column?: number; message: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(.+?\.java):(\d+)(?::(\d+))?:\s*(error|warning):\s*(.*)$/);
    if (match) diagnostics.push({
      severity: match[4], file: match[1].replace(/^\/workspace\//, ''), line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}), message: match[5]
    });
  }
  return diagnostics;
}

wss.on('connection', (ws) => {
  let current: Job | null = null;

  async function finish(state: string, message: string, diagnostics?: unknown[]) {
    if (!current || current.finished) return;
    const job = current;
    job.finished = true;
    current = null;
    if (job.timer) clearTimeout(job.timer);
    if (job.proc && !job.proc.killed) job.proc.kill('SIGTERM');
    for (const container of [job.compileName, job.runtimeName]) {
      const killer = spawn('docker', ['stop', '--time', '1', container], { stdio: 'ignore' });
      killer.on('error', () => undefined);
    }
    try { await fs.rm(job.workspace, { recursive: true, force: true }); } catch { /* cleanup best effort */ }
    activeRuns = Math.max(0, activeRuns - 1);
    send(ws, { type: 'status', state, message, runId: job.id, ...(diagnostics ? { diagnostics } : {}) });
  }

  ws.on('message', async (raw) => {
    let message: any;
    try { message = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'status', state: 'internal_error', message: 'Invalid JSON message.' }); return; }

    if (message.type === 'stdin') {
      if (current?.proc && !current.finished && typeof message.data === 'string' && message.data.length <= 10000) {
        current.proc.stdin.write(message.data);
      }
      return;
    }
    if (message.type === 'stop') {
      await finish('cancelled', 'Execution stopped by user.');
      return;
    }
    if (message.type !== 'run') return;
    if (current) { send(ws, { type: 'status', state: 'internal_error', message: 'This connection already has an active run.' }); return; }
    if (activeRuns >= MAX_CONCURRENT_RUNS) { send(ws, { type: 'status', state: 'internal_error', message: 'Execution worker is busy. Try again shortly.' }); return; }

    let files: SubmittedFile[];
    let args: string[];
    try {
      files = validateFiles(message.files, MAX_FILES, MAX_SOURCE_BYTES);
      args = readArgs(message.args);
    } catch (error) {
      send(ws, { type: 'status', state: 'internal_error', message: error instanceof Error ? error.message : 'Invalid project.' });
      return;
    }
    const action = message.action === 'compile' ? 'compile' : 'run';
    const candidates = detectMainClasses(files);
    let entry = message.mainClass;
    if (action === 'run') {
      if (entry !== undefined && !isMainClass(entry)) { send(ws, { type: 'status', state: 'internal_error', message: 'Invalid main class name.' }); return; }
      if (!entry && candidates.length === 1) entry = candidates[0];
      if (!entry && candidates.length === 0) {
        send(ws, { type: 'status', state: 'no_entry_point', message: 'No main method was detected in these source files.', candidates: [] });
        return;
      }
      if (!entry && candidates.length > 1) {
        send(ws, { type: 'status', state: 'multiple_entry_points', message: 'Choose the main class to run.', candidates });
        return;
      }
    }

    const id = crypto.randomUUID();
    const job: Job = {
      id, workspace: await fs.mkdtemp(path.join(os.tmpdir(), 'airjava-')),
      compileName: 'airjava-c-' + id.slice(0, 12), runtimeName: 'airjava-r-' + id.slice(0, 12),
      proc: null, timer: null, outputBytes: 0, finished: false
    };
    current = job;
    activeRuns += 1;
    try {
      await fs.chmod(job.workspace, 0o777);
      const sourcePaths: string[] = [];
      for (const file of files) {
        const target = path.join(job.workspace, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
        sourcePaths.push(file.path);
      }
      await fs.mkdir(path.join(job.workspace, 'out'), { recursive: true });
      await fs.chmod(path.join(job.workspace, 'out'), 0o777);
      send(ws, { type: 'status', state: 'compiling', message: 'Compiling with the Java 21 JDK…', runId: id });

      let compilerOutput = '';
      const runDocker = (dockerArgs: string[], phase: 'compile' | 'runtime') => new Promise<{ code: number | null }>((resolve, reject) => {
        let settled = false;
        const proc = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        job.proc = proc;
        const settle = (error?: Error, code: number | null = null) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve({ code });
        };
        const output = (chunk: Buffer, kind: 'stdout' | 'stderr') => {
          const text = chunk.toString('utf8');
          if (phase === 'compile') compilerOutput += text;
          job.outputBytes += chunk.length;
          if (job.outputBytes > MAX_OUTPUT_BYTES) {
            void finish('output_limit', 'Output limit exceeded. Execution was terminated.');
            return;
          }
          send(ws, { type: phase === 'compile' ? 'build' : kind, text, runId: id });
        };
        proc.stdout.on('data', (chunk: Buffer) => output(chunk, 'stdout'));
        proc.stderr.on('data', (chunk: Buffer) => output(chunk, 'stderr'));
        proc.on('error', (error) => settle(error));
        proc.on('close', (code) => settle(undefined, code));
      });

      job.timer = setTimeout(() => { void finish('timed_out', 'Execution exceeded the configured ' + (TIMEOUT_MS / 1000) + ' second limit.'); }, TIMEOUT_MS);
      const compiled = await runDocker([...dockerBase(job.compileName, job.workspace), 'javac', '-encoding', 'UTF-8', '-Xlint:all', '-d', 'out', '-sourcepath', '.', ...sourcePaths], 'compile');
      if (job.finished || current?.id !== id) return;
      if (compiled.code !== 0) {
        await finish('compile_failed', 'Compilation failed. Review Build Output and Problems.', parseDiagnostics(compilerOutput));
        return;
      }
      send(ws, { type: 'status', state: 'compiled', message: 'Compilation successful.', runId: id });
      if (action === 'compile') {
        await finish('completed', 'Compilation successful. No program was launched.');
        return;
      }
      send(ws, { type: 'status', state: 'running', message: 'Program is running. Enter input when prompted.', runId: id });
      const started = Date.now();
      const runtime = await runDocker([
        ...dockerBase(job.runtimeName, job.workspace), 'java', '-Xms16m', '-Xmx128m',
        '-Dfile.encoding=UTF-8', '-cp', 'out', entry, ...args
      ], 'runtime');
      if (job.finished || current?.id !== id) return;
      if (job.timer) clearTimeout(job.timer);
      await finish(runtime.code === 0 ? 'completed' : 'runtime_error',
        'Process exited with code ' + (runtime.code === null ? 'unknown' : runtime.code) + ' in ' + (Date.now() - started) + ' ms.');
    } catch (error) {
      if (!job.finished) await finish('internal_error',
        'Could not start the Java sandbox. Confirm Docker is running and image ' + IMAGE + ' is built. ' +
        (error instanceof Error ? error.message : ''));
    }
  });

  ws.on('close', () => { void finish('cancelled', 'Client disconnected; execution was terminated.'); });
  ws.on('error', () => { void finish('cancelled', 'Terminal connection failed.'); });
});

server.listen(PORT, HOST, () => console.log('AirJava API listening on http://' + HOST + ':' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));