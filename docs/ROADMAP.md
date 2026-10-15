# AirJava roadmap

## Core workspace
- [x] Monaco Java editor, tabs, and source file explorer
- [x] Class creation, source imports, ZIP import/export, browser-local saving
- [x] Run and Compile actions with WebSocket connection
- [x] Real javac/java execution in disposable Docker containers
- [x] Line-oriented stdin and streamed stdout/stderr
- [x] Compiler diagnostics and clickable source locations
- [x] Execution timeout, output cap, CPU/memory/PID limits, non-root sandbox

## Verification still required
- [ ] End-to-end Docker run on a host with Docker Engine installed
- [ ] Interactive Scanner.nextLine(), Scanner.nextInt(), and multiple prompts
- [ ] Multi-file packages and multiple main classes
- [ ] Cancellation, timeout, large output, and client disconnect cleanup
- [ ] Frontend browser, accessibility, and responsive tests

## Production hardening
- [ ] Authentication and per-user execution quotas
- [ ] Dedicated execution worker hosts and queue-backed orchestration
- [ ] Structured logs, metrics, alerting, and session expiry
- [ ] Security review of Docker and WebSocket boundaries

## Advanced IDE
- [ ] Java language-server integration
- [ ] JDI/JDWP debugger and breakpoints
- [ ] Formatter, import organization, and JUnit runner
- [ ] Cloud projects, recent projects, and Git integration

Features should only be marked complete after real tests verify them. The Docker execution path is implemented in source but is not marked end-to-end verified yet.