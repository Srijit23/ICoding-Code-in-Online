# AirJava

AirJava is a browser-based Java IDE for learning and writing Java. This branch starts the implementation of a professional editor, real Java compilation, interactive standard input, streamed output, compiler diagnostics, and multi-file projects.

> **Status:** Early implementation. The UI and Docker-backed execution path are scaffolded, but this has not been security-audited or verified end-to-end against Docker. Do not expose an unauthenticated instance to the public internet.

## Features in this branch

- React + Vite + TypeScript UI with Monaco Editor.
- Project file list, editor tabs, local autosave, class creation, Java file import, and ZIP export.
- Compile/Run flow backed by real javac and java in a disposable Docker sandbox.
- WebSocket messages for process status, compiler output, stdout/stderr, line input, and cancellation.
- Compiler diagnostics with source locations.
- Execution timeout and Docker limits for memory, CPU, processes, filesystem write access, and network access.
- Dark-first, responsive IDE layout.

## Requirements

- Node.js 20+ and npm.
- Docker Engine/Desktop running on the same host as the API.
- Permission for the API process to launch Docker containers.

## Local setup

    npm install
    cp .env.example .env
    docker build -t airjava-sandbox:21 ./sandbox
    npm run dev

The frontend runs at http://localhost:5173; the API defaults to http://127.0.0.1:4000. The Vite development server proxies /api and /ws to the API.

    npm test
    npm run build

## Execution model

The browser sends a source snapshot to the WebSocket API. The server validates filenames and source size, writes files to a temporary workspace, compiles all Java files with javac in a disposable container, and only launches the selected main class after successful compilation. Output is streamed to the browser. Terminal input is sent to the running process's standard input one line at a time.

Docker constraints include a non-root container user, no network by default, read-only container root, dropped capabilities, no-new-privileges, CPU/memory/PID limits, output limits, and execution timeout. These are defense-in-depth controls, not a proof of production security.

## Current limitations

- Docker-backed compilation/runtime has not been end-to-end tested in this environment.
- WebSocket origin allowlisting is not authentication. Add authentication, per-user quotas, isolated worker hosts, monitoring, and a security review before public multi-user deployment.
- Main-class detection is heuristic. Raw-mode terminal applications are not supported.
- Java language-server intelligence, advanced refactoring, JDI/JDWP debugging, BlueJ object bench, formatter, JUnit, cloud accounts, and cloud project sync are not implemented yet.
- Workspace autosave is browser-local. Export ZIPs for backup.

See docs/ROADMAP.md for the implementation checklist and .env.example for configuration.
