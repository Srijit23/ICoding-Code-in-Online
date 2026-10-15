import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import JSZip from 'jszip';
import { Activity, AlertCircle, Braces, Check, ChevronDown, ChevronRight, Code2, Download, FileCode2, FilePlus2, FolderOpen, Play, Plus, Save, Square, Sun, Moon, Terminal, Upload, X } from 'lucide-react';

type SourceFile = { path: string; content: string };
type Diagnostic = { severity: string; file: string; line: number; column?: number; message: string };
type RunStatus = { state: string; message?: string; candidates?: string[]; diagnostics?: Diagnostic[] };

const KEY = 'airjava-workspace';
const STARTER = [
  'import java.util.Scanner;',
  '',
  'public class Main {',
  '    public static void main(String[] args) {',
  '        Scanner sc = new Scanner(System.in);',
  '        System.out.print("Enter your name: ");',
  '        String name = sc.nextLine();',
  '        System.out.println("Hello, " + name + "!");',
  '    }',
  '}',
  ''
].join('\n');
const STUDENT = [
  'public class Student {',
  '    private final String name;',
  '    private final int rollNumber;',
  '',
  '    public Student(String name, int rollNumber) {',
  '        this.name = name;',
  '        this.rollNumber = rollNumber;',
  '    }',
  '',
  '    public String getName() { return name; }',
  '    public int getRollNumber() { return rollNumber; }',
  '}',
  ''
].join('\n');

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string) {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'airjava-project';
}

function initialWorkspace() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.files) && parsed.files.length) return parsed;
    }
  } catch { /* use starter */ }
  return { name: 'My Java Project', files: [{ path: 'Main.java', content: STARTER }, { path: 'Student.java', content: STUDENT }], active: 'Main.java', theme: 'dark' };
}

export default function App() {
  const initial = useMemo(initialWorkspace, []);
  const [projectName, setProjectName] = useState(initial.name);
  const [files, setFiles] = useState<SourceFile[]>(initial.files);
  const [active, setActive] = useState(initial.active);
  const [tabs, setTabs] = useState<string[]>([initial.active]);
  const [theme, setTheme] = useState<'dark' | 'light'>(initial.theme || 'dark');
  const [status, setStatus] = useState<RunStatus>({ state: 'idle', message: 'Ready to compile.' });
  const [panel, setPanel] = useState<'console' | 'problems' | 'build'>('console');
  const [output, setOutput] = useState('AirJava terminal · Java 21\nClick Run to execute your program. Input is submitted one line at a time.\n\n');
  const [build, setBuild] = useState('');
  const [problems, setProblems] = useState<Diagnostic[]>([]);
  const [entryCandidates, setEntryCandidates] = useState<string[]>([]);
  const [mainClass, setMainClass] = useState('');
  const [args, setArgs] = useState('');
  const [input, setInput] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const [toast, setToast] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const editor = useRef<any>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const running = ['connecting', 'queued', 'compiling', 'running'].includes(status.state);
  const current = files.find((file) => file.path === active) || files[0];

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ name: projectName, files, active, theme })); } catch { setToast('Local storage is full. Export a ZIP backup.'); }
  }, [projectName, files, active, theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run('run');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        try { localStorage.setItem(KEY, JSON.stringify({ name: projectName, files, active, theme })); setToast('Workspace saved locally.'); }
        catch { setToast('Could not save workspace.'); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openFile(path: string) {
    setActive(path);
    setTabs((existing) => existing.includes(path) ? existing : [...existing, path]);
  }

  function changeCode(value: string) {
    setFiles((all) => all.map((file) => file.path === active ? { ...file, content: value } : file));
  }

  function addClass() {
    const raw = window.prompt('Name your new Java class', 'NewClass');
    if (!raw) return;
    const name = raw.trim().replace(/\.java$/i, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) { setToast('Enter a valid Java class name.'); return; }
    const path = name + '.java';
    if (files.some((file) => file.path === path)) { setToast('That file already exists.'); return; }
    setFiles((all) => [...all, { path, content: 'public class ' + name + ' {\n    public ' + name + '() {\n        // Initialize this object.\n    }\n}\n' }]);
    openFile(path);
  }

  function closeTab(path: string) {
    const rest = tabs.filter((tab) => tab !== path);
    setTabs(rest);
    if (active === path) setActive(rest[rest.length - 1] || files.find((file) => file.path !== path)?.path || '');
  }

  function deleteClass(path: string) {
    if (files.length < 2) { setToast('A project must contain at least one Java file.'); return; }
    if (!window.confirm('Delete ' + path + '?')) return;
    const rest = files.filter((file) => file.path !== path);
    setFiles(rest);
    setTabs((existing) => existing.filter((tab) => tab !== path));
    if (active === path) setActive(rest[0].path);
  }

  async function importFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    const incoming = await Promise.all(selected.map(async (file) => ({ path: file.name, content: await file.text() })));
    setFiles((old) => {
      const merged = new Map(old.map((file) => [file.path, file]));
      incoming.forEach((file) => merged.set(file.path, file));
      return [...merged.values()];
    });
    openFile(incoming[0].path);
    setToast('Imported ' + incoming.length + ' Java source file(s).');
    event.target.value = '';
  }

  async function importZip(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const archive = await JSZip.loadAsync(file);
      const sources: SourceFile[] = [];
      for (const [path, item] of Object.entries(archive.files)) {
        if (item.dir || !path.endsWith('.java')) continue;
        const clean = path.replace(/\\/g, '/');
        if (clean.startsWith('/') || clean.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Unsafe archive path: ' + path);
        sources.push({ path: clean, content: await item.async('string') });
      }
      if (!sources.length) throw new Error('No Java source files were found in that ZIP.');
      setFiles(sources);
      setProjectName(file.name.replace(/\.zip$/i, '') || 'Imported Project');
      setActive(sources[0].path);
      setTabs([sources[0].path]);
      setToast('Imported ' + sources.length + ' Java source file(s).');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not import ZIP.'); }
    event.target.value = '';
  }

  async function exportZip() {
    const archive = new JSZip();
    files.forEach((file) => archive.file(file.path, file.content));
    const blob = await archive.generateAsync({ type: 'blob' });
    download(blob, safeName(projectName) + '.zip');
    setToast('Project ZIP exported.');
  }

  function run(action: 'run' | 'compile') {
    if (running) return;
    socket.current?.close();
    setStatus({ state: 'connecting', message: action === 'run' ? 'Connecting to Java runtime…' : 'Connecting to compiler…' });
    setBuild('');
    setProblems([]);
    setEntryCandidates([]);
    setPanel(action === 'run' ? 'console' : 'build');
    if (action === 'run') setOutput('AirJava terminal · Java 21\n────────────────────────────────────────\n');
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'run',
      action,
      files: files.map((file) => ({ path: file.path, content: file.content })),
      mainClass: mainClass || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : []
    }));
    ws.onmessage = (event) => {
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'status') {
        setStatus({ state: message.state, message: message.message, candidates: message.candidates, diagnostics: message.diagnostics });
        if (message.state === 'multiple_entry_points') setEntryCandidates(message.candidates || []);
        if (message.state === 'compile_failed') {
          setProblems(message.diagnostics || []);
          setPanel('problems');
        }
        if (['completed', 'compile_failed', 'runtime_error', 'timed_out', 'cancelled', 'output_limit', 'internal_error', 'no_entry_point', 'multiple_entry_points'].includes(message.state)) {
          setOutput((old) => old + '\n' + (message.message || message.state) + '\n');
          ws.close();
        }
      } else if (message.type === 'stdout' || message.type === 'stderr') {
        setOutput((old) => old + message.text);
      } else if (message.type === 'build') {
        setBuild((old) => old + message.text);
      }
    };
    ws.onerror = () => setStatus({ state: 'internal_error', message: 'Cannot connect to the API. Start the AirJava backend.' });
  }

  function stop() {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'stop' }));
    else setStatus({ state: 'idle', message: 'Ready to compile.' });
  }

  function sendInput(event: React.FormEvent) {
    event.preventDefault();
    if (!input.trim() && input.length === 0) return;
    if (socket.current?.readyState !== WebSocket.OPEN || status.state !== 'running') {
      setToast('Run a program that is waiting for input first.');
      return;
    }
    setOutput((old) => old + input + '\n');
    socket.current.send(JSON.stringify({ type: 'stdin', data: input + '\n' }));
    setInput('');
  }

  function goTo(problem: Diagnostic) {
    const file = files.find((item) => item.path === problem.file || item.path.endsWith(problem.file));
    if (!file) { setToast('Could not find ' + problem.file + ' in the workspace.'); return; }
    openFile(file.path);
    window.setTimeout(() => {
      editor.current?.revealLineInCenter(problem.line);
      editor.current?.setPosition({ lineNumber: problem.line, column: problem.column || 1 });
      editor.current?.focus();
    }, 80);
  }

  return (
    <div className={'app ' + theme}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Braces size={18} /></div><strong>Air<span>Java</span></strong><span className="brand-divider" /><button className="project" onClick={() => { const name = window.prompt('Project name', projectName); if (name?.trim()) setProjectName(name.trim()); }}>{projectName}<ChevronDown size={13} /></button></div>
        <div className="runtime"><i /> Java 21 <span>·</span> JDK runtime</div>
        <div className="actions"><button className="plain" onClick={() => { localStorage.setItem(KEY, JSON.stringify({ name: projectName, files, active, theme })); setToast('Workspace saved locally.'); }}><Save size={14} />Save</button>{running ? <button className="stop" onClick={stop}><Square size={13} fill="currentColor" />Stop</button> : <><button className="compile" onClick={() => run('compile')}><Check size={14} />Compile</button><button className="run" onClick={() => run('run')}><Play size={13} fill="currentColor" />Run <kbd>Ctrl ↵</kbd></button></>}</div>
      </header>
      <div className="layout">
        <aside className="rail"><button className={sidebar ? 'selected' : ''} title="Explorer" onClick={() => setSidebar((value) => !value)}><FolderOpen size={18} /></button><button title="New class" onClick={addClass}><FilePlus2 size={18} /></button><button title="Keyboard shortcut: Ctrl+Enter" onClick={() => setToast('Ctrl + Enter runs the current project.')}><Code2 size={18} /></button><div className="rail-spacer" /><button title="Toggle theme" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button></aside>
        {sidebar && <aside className="explorer"><div className="explorer-title">EXPLORER <button title="New class" onClick={addClass}><Plus size={15} /></button><button title="Import Java files" onClick={() => fileInput.current?.click()}><Upload size={14} /></button><button title="Import project ZIP" onClick={() => zipInput.current?.click()}><Download size={14} /></button></div><div className="folder"><ChevronDown size={13} /><FolderOpen size={14} /><span>{projectName.toUpperCase()}</span></div><div className="tree">{files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => <div className={'tree-row ' + (file.path === active ? 'active' : '')} key={file.path} onClick={() => openFile(file.path)}><FileCode2 size={14} /><span>{file.path}</span><button title={'Delete ' + file.path} onClick={(event) => { event.stopPropagation(); deleteClass(file.path); }}><X size={12} /></button></div>)}</div><div className="explorer-footer">{files.length} source files <span>Saved locally</span></div></aside>}
        <main className="workarea">
          <div className="crumb"><span>{projectName}</span><ChevronRight size={13} /><FileCode2 size={14} />{current?.path || 'Main.java'}<div className="crumb-actions"><button title="Download current file" onClick={() => current && download(new Blob([current.content], { type: 'text/x-java-source;charset=utf-8' }), current.path.split('/').pop() || 'Main.java')}><Download size={14} /></button><button title="Toggle light/dark theme" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button></div></div>
          <div className="tabs">{tabs.map((tab) => <div className={'tab ' + (tab === active ? 'active' : '')} key={tab} onClick={() => setActive(tab)}><FileCode2 size={13} />{tab.split('/').pop()}<button title={'Close ' + tab} onClick={(event) => { event.stopPropagation(); closeTab(tab); }}><X size={12} /></button></div>)}<button className="addtab" title="New class" onClick={addClass}><Plus size={14} /></button><span className="language">Java</span></div>
          <div className="editor"><Editor path={current?.path || 'Main.java'} language="java" theme={theme === 'dark' ? 'vs-dark' : 'light'} value={current?.content || ''} onChange={(value) => changeCode(value || '')} onMount={(instance) => { editor.current = instance; }} options={{ automaticLayout: true, fontFamily: 'DM Mono, Consolas, monospace', fontSize: 13, lineHeight: 22, minimap: { enabled: true }, lineNumbers: 'on', glyphMargin: true, folding: true, scrollBeyondLastLine: false, smoothScrolling: true, bracketPairColorization: { enabled: true }, autoClosingBrackets: 'always', autoClosingQuotes: 'always', tabSize: 4, wordWrap: 'off', padding: { top: 14, bottom: 18 }, overviewRulerBorder: false }} /></div>
          <section className="bottom"><div className="bottom-head"><div className="panel-tabs"><button className={panel === 'console' ? 'active' : ''} onClick={() => setPanel('console')}><Terminal size={14} />Console</button><button className={panel === 'problems' ? 'active' : ''} onClick={() => setPanel('problems')}><AlertCircle size={14} />Problems <b>{problems.length}</b></button><button className={panel === 'build' ? 'active' : ''} onClick={() => setPanel('build')}><Activity size={14} />Build Output</button></div><span className={'status ' + (['completed', 'compiled'].includes(status.state) ? 'ok' : running ? 'busy' : ['idle'].includes(status.state) ? '' : 'bad')}><i />{status.message || status.state}</span></div>
            <div className="panel-content">
              {panel === 'console' && <><pre className="console-output">{output}</pre><form className="stdin" onSubmit={sendInput}><span>&gt;</span><input value={input} onChange={(event) => setInput(event.target.value)} placeholder={status.state === 'running' ? 'Type input and press Enter…' : 'Run a program to enter input'} disabled={status.state !== 'running'} /><button disabled={status.state !== 'running'}>Send ↵</button></form></>}
              {panel === 'build' && <pre className="build-output">{build || 'Compiler output appears here after you compile the project.'}</pre>}
              {panel === 'problems' && <div className="problem-list">{problems.length ? problems.map((problem, index) => <button className="problem" key={problem.file + problem.line + index} onClick={() => goTo(problem)}><AlertCircle size={14} /><span>{problem.message}</span><small>{problem.file}:{problem.line}{problem.column ? ':' + problem.column : ''}</small></button>) : <div className="no-problems"><Check size={17} /><span>No compiler problems to show.</span></div>}</div>}
            </div>
            {entryCandidates.length > 0 && <div className="entry-select"><span>Choose a main class</span><select value={mainClass} onChange={(event) => setMainClass(event.target.value)}><option value="">Choose entry point…</option>{entryCandidates.map((candidate) => <option key={candidate}>{candidate}</option>)}</select><button onClick={() => run('run')} className="run small-run"><Play size={12} />Run selected</button></div>}
            <div className="arg-row"><label>PROGRAM ARGUMENTS</label><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="Optional args passed to main(String[] args)" /><span>space-separated</span></div>
          </section>
        </main>
      </div>
      <footer className="statusbar"><span><i /> main* <span>Sandboxed execution</span><span>JDK 21</span></span><span>UTF-8　 ·　 Spaces: 4　 ·　 Java　 ·　 Ctrl+Enter to run</span></footer>
      <input ref={fileInput} hidden type="file" accept=".java,text/x-java-source" multiple onChange={importFiles} />
      <input ref={zipInput} hidden type="file" accept=".zip,application/zip" onChange={importZip} />
      {toast && <div className="toast"><Check size={14} />{toast}</div>}
    </div>
  );
}