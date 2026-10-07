# Linear TUI security review

Reviewed 6 October 2026. Target: `k1-c/linear-tui`, commit `fa79ffed365c2deff1916022abe8652989682216`, package version `0.13.0`, Herdr plugin version `0.4.0`.

**Recommendation:** reuse the Rust application and its JSON CLI, with a small hardening patch set before unattended factory use. Keep its credentials and control endpoints outside agent sandboxes. The source review found concrete file handling and availability defects, plus a workspace selection hazard that matters particularly for automation. It did not establish a remote code execution exploit.

## Scope and evidence

The review covered authentication and token refresh, credential and temporary files, the local TUI control server, GraphQL request handling, headless output, task resolution, Herdr scripts, plugin manifests, and CI configuration. Findings refer to the pinned source, rather than an unspecified latest release.

Validation performed:

- Queried OSV for all **370 registry package and version entries** in the checked-out `Cargo.lock`: **zero matching published advisories** returned. This is a point-in-time dependency lookup, not proof that dependencies are safe.
- Executed the actual `herdr-plugin/deliver.sh` against disposable local stubs, with synthetic notes and `umask 022`. Its undelivered note had mode `0644`, and its directory had mode `0755`.
- Reproduced the POSIX open, truncate, write, and rename sequence from `private_file.rs` against disposable files. A pre-created sibling symlink caused the target file to be overwritten and the final destination to remain a symlink. This reproduces the filesystem primitive; it is not a compiled Rust application exploit.
- Traced the control socket and workspace selection paths statically. No live Linear account, actual Herdr session, or external agent was used for exploit testing.

Rust and Cargo were unavailable on the current PATH, so the Rust test suite, `cargo audit`, and binary-level exploit tests were not run. No comprehensive fuzzing, Windows ACL validation, release-binary provenance audit, or penetration test was performed. The conclusions below distinguish defects visible in code from exploit conditions that still need validation.

## Findings

### LT01 Local control connections can consume unbounded resources

**Severity:** medium, local availability. **Evidence:** confirmed in source; no resource-exhaustion attack executed.

`listen()` spawns a task for every accepted loopback connection. `serve()` calls `read_line()` without a request size limit or read timeout, and checks the authentication token only after reading and parsing the entire line. The command queue is unbounded too. An unauthenticated local process can open connections and leave them hanging, or send a large line, consuming memory and task resources before authentication. Binding to loopback restricts reachability but does not authenticate other local users.

Sources: [listener and task creation](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/interface/control/mod.rs#L109), [request read and token check](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/interface/control/mod.rs#L150).

**Required fix:** cap concurrent connections, enforce a short pre-authentication read deadline, reject oversized frames before allocating an unbounded string, bound the command queue, and time out responses. Suggested starting limits: 16 connections, 64 KiB per request, a 5-second read deadline, and 32 queued commands. Validate these against legitimate long descriptions. Tie the accept task's lifetime to the endpoint guard.

**Factory mitigation:** set `[agent] control = false`; use the JSON CLI through the trusted task adapter. Worker VMs receive neither the control file nor access to the host loopback service.

### LT02 Predictable temporary files follow symlinks and collide between writers

**Severity:** medium when an attacker can plant files in the target directory; otherwise a reliability and hardening issue. **Evidence:** source confirmed and filesystem primitive reproduced.

`private_file::write()` uses the fixed sibling name `.<filename>.tmp`. It opens that path with create, write, and truncate flags, without exclusive creation or a no-follow check. `chmod(0600)` happens after open and does not prevent following an existing symlink. `open_append()` has a related symlink-following behavior for logs.

The editor uses a predictable PID and counter filename in `temp_dir()`, and invokes the same writer. A writable shared temporary directory increases exposure. Default macOS per-user temporary directories, private parent directories, and operating-system symlink protections can prevent a cross-user attack; this is not a claim that every default installation is exploitable. A process already running with the victim's full user privileges generally has broader access anyway.

Sources: [temporary sibling and rename](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/private_file.rs#L18), [file open flags](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/private_file.rs#L43), [editor filename](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/infra/editor.rs#L56).

**Required fix:** create an unpredictable temporary file exclusively in a verified owner-only directory; write, sync, and atomically persist it. Reject unsafe directory ownership and symlink substitutions. Use a private temporary directory for editor files. Use no-follow semantics and file type checks for append-only logs. Add interprocess locking separately: unique temporary names alone do not solve lost updates.

**Regression checks:** pre-planted symlink, simultaneous writers, stale temporary file, malicious parent directory, and interrupted write. Tests must use disposable files and verify the victim sentinel remains unchanged.

### LT03 Undelivered notes lose their private file permissions

**Severity:** low to medium confidentiality, depending on parent directory traversal permissions. **Evidence:** reproduced with the actual shell script.

The Rust outbox is written privately, but `keep()` saves its contents with ordinary shell redirection after `mkdir -p`. Under `umask 022`, the fallback Markdown file is `0644` and the new directory `0755`. Notes containing internal task details become readable by other users if the containing directories allow traversal. A private ancestor directory mitigates access but does not make the output file itself private.

Source: [undelivered note creation](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/herdr-plugin/deliver.sh#L15).

**Required fix:** create and verify owner-only state directories; set `umask 077` before creating files; write through a secure exclusive temporary file and atomically rename. Reject symlink destinations. Test permissions on both first creation and replacement.

**Factory mitigation:** provision all factory and adapter state directories as `0700`. Route task handoffs through a structured factory command with a task UUID, rather than the plugin's free-form agent selection mechanism.

### LT04 Issue URLs discard the workspace before executing commands

**Severity:** medium integrity; potentially high operational impact across sensitive workspaces. **Evidence:** confirmed resolution path; no real workspace mutated.

`issue_key()` accepts a Linear URL but discards its organization path segment, returning only the issue identifier. Headless commands select the globally current stored account. Therefore a command naming `https://linear.app/workspace-a/issue/ENG-42/...` can resolve `ENG-42` in workspace B if B is active and contains that identifier. A concurrent `auth switch` changes the account used by the next process. The context command's warning does not enforce the target on later mutations.

This is a confused-target hazard within accounts the user can already access, not a bypass of Linear's server authorization.

Sources: [URL conversion](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/interface/cli/issue.rs#L729), [CLI authentication](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/commands.rs#L39), [selection of the current account](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/infra/linear/auth/mod.rs#L70).

**Required fix:** add explicit organization selection per invocation, bind the selected credential for the full operation, retain and validate URL organization information, and require UUID-based mutation targets after scoped resolution. Reject an organization mismatch. Do not implement account pinning as `auth switch` followed by another command: that remains racy.

**Factory release gate:** every task stores organization UUID, team UUID, and issue UUID. Mutations must be tied to that tuple and verified by readback. Cross-workspace duplicate identifiers must be an integration test.

### LT05 Token updates and refreshes are not coordinated between processes

**Severity:** medium operational integrity and availability. **Evidence:** confirmed source race; token server behavior not exercised.

`TokenStore::update()` reads, changes, and saves without an interprocess lock. Concurrent processes can overwrite each other's account changes. The shared fixed temporary filename compounds the risk: one writer can truncate or rename a file another writer still uses. `OAuthSession` has an in-process mutex, but separate TUI and CLI processes can refresh the same stored token independently. Depending on Linear's refresh-token behavior, that can cause refresh failures or preserve stale credentials.

Sources: [token update](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/infra/linear/auth/token.rs#L202), [session mutex and refresh](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/infra/linear/auth/session.rs#L17).

**Required fix:** lock the account store across read/modify/write, coordinate refresh per organization, reread after acquiring the refresh lock, and atomically persist the new pair. A credential broker is an alternative longer-term design. Never log tokens. Test simultaneous TUI and CLI refresh, account switching during refresh, and process termination during persistence.

**Factory mitigation:** serialize adapter operations and use an explicitly scoped credential profile. This reduces factory concurrency but does not replace upstream locking when the human TUI uses the same store.

### LT06 Markdown CLI output carries unescaped terminal control characters

**Severity:** medium candidate, dependent on upstream content acceptance and terminal behavior. **Evidence:** unsanitized output path confirmed; end-to-end exploitability unverified.

Issue titles, descriptions, and comment bodies are appended directly to Markdown output, which is printed to stdout. If Linear preserves embedded terminal control sequences, a contributor can influence terminal display and, in some terminals, clipboard or hyperlink behavior when a user prints the issue. This review did not establish that Linear accepts the required sequences, or that Herdr forwards every relevant sequence. It is not evidence of shell command execution.

Sources: [stdout output](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/interface/cli/issue.rs#L18), [issue and comment rendering](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/src/interface/cli/issue.rs#L809).

**Required hardening:** strip or visibly escape terminal controls at every text display boundary while preserving normal newlines and tabs. Use JSON for machine transport, then sanitize after decoding before rendering. Test OSC, CSI, carriage return, and bidirectional text handling without sending live escape sequences to the operator's terminal.

## Additional observations

- **Prompt injection boundary:** task descriptions and comments are untrusted data. The Herdr handoff embeds issue titles alongside user notes and selects an agent heuristically. A factory must resolve an explicit run and label source content; a title or comment cannot authorize tools, publication, or approval. This is an integration design requirement, rather than a demonstrated Rust vulnerability.
- **Shell configuration:** `herdr-plugin/lib.sh` sources `config.env`, so it is executable shell despite being described as plain `KEY=value` configuration. That is acceptable only as trusted, user-owned plugin configuration. The factory should use a validated data format for adapter settings and never source repository-supplied configuration on the host.
- **Windows privacy:** the non-Unix private-file functions do not establish owner-only ACLs themselves. Actual access depends on inherited ACLs. Windows is outside the proposed local v1 target, but needs explicit testing before support is claimed.
- **OAuth cancellation:** the five-minute wait timeout does not cancel the blocking callback accept loop. A cancelled login may leave a listener/task alive until process termination; Tokio runtime shutdown can also wait on a running blocking task. Add a bounded, cancellable accept loop. This was traced statically, not reproduced against a login.
- **Coverage limitation:** issue listing stops after at most ten pages and exposes `more`. A factory must not treat that as a complete source scan. Issue detail and nested connection coverage also need explicit pagination indicators before unattended queue processing.

## Controls already present

OAuth uses PKCE S256 and random state; callback state is checked before completing login; the callback binds to IPv4 loopback; HTML errors are escaped; the GraphQL endpoint is fixed to HTTPS and requests use variables; ordinary editor invocation uses an argv array; Unix credential files request mode `0600`; CI includes a security audit and pins action references to commit SHAs. These are useful controls. The baked-in OAuth client identifier is a public client ID, not an exposed client secret.

## Adoption decision

Proceed with design and a pinned hardening fork or upstream patch series. Before live unattended task writes, require LT01 through LT05 to be fixed or demonstrably disabled, add output sanitization for LT06, and pass account-scope, process-race, file-permission, and negative authorization tests. Preserve the Rust client as the source of Linear API behavior; expose it only through a narrowly scoped factory adapter.

This review does not authorize installing the software, using personal credentials, changing Linear issues, or publishing a vulnerability report. Those activities were not performed.
