# Local agentic software factory specification

Implementation target, 6 October 2026. Revised to keep the first release small. Implementation and validation are in progress; [compatibility.md](compatibility.md) records verified behavior and remaining checks.

Build a local software delivery assistant operated inside Herdr. Pi supplies agent sessions; smolmachines executes repository work in Linux microVMs; linear-tui supplies the human task interface and a read-only task API. One TypeScript supervisor owns the workflow, with SQLite for durable run state and files for artifacts.

The first useful flow is:

**Select one issue → plan → human approval → implement → verify → review and bounded repair → human approval of the candidate → manual publication and merge.**

Agents work autonomously between the two approval gates, within the approved scope. Deterministic code enforces those gates, tool permissions, budgets, and verification requirements. Orchestration and repository execution stay on this machine; hosted model APIs and Linear reads are allowed.

## Revision note (2026-10-09)

The first release ran every model tool and check in a smol microVM. That
engine was removed when its stop/deny-all/restart policy switch began
re-pulling images at every restart (see docs/compatibility.md). Execution now
happens on the host inside Anthropic's `sandbox-runtime` (Seatbelt on macOS,
bubblewrap on Linux): writes confined to a disposable stage workspace and the
factory cache, credentials and the live checkout unreadable, network denied
except an explicit dependency allowlist. Herdr is optional, the supervisor can
run detached, and `factory init` / `/factory-init` register a repository from
inside it. Wherever the text below says "VM" or "guest", read "sandboxed
workspace"; the approval, evidence and recovery contracts are unchanged.

## First release boundary

| Decision | First release |
| --- | --- |
| Operator | One person on this Apple Silicon Mac |
| Scope | One configured repository, one Linear organization, one executing run |
| Intake | A manually selected issue; basic triage is part of planning |
| Interface | linear-tui and the factory Pi conversation inside Herdr; a simple status command |
| Process | One foreground supervisor, with Pi SDK sessions inside it |
| Bring-up | A root Makefile: `make setup` prepares dependencies; `make up` starts the complete configured local workspace |
| Workflow | One explicit TypeScript transition table and concrete stage functions |
| Persistence | SQLite run records, approvals, stage results, and artifact references |
| Execution | smol local microVMs, with a fresh verification environment |
| Delivery | A local candidate commit, diff, verification results, and review findings |
| Integration | The operator publishes and merges manually |
| Recovery | Interrupted work stays stopped; explicit restart from a saved candidate after old execution is confirmed stopped |

The first release includes planning, implementation, trusted verification, independent review, at most two automatic repair rounds, human questions and steering, cancellation, and persisted completed stages. Planner, implementer, and reviewer use separate sessions and run sequentially. Only one session may mutate a candidate. Allow one unfinished run per issue; a run waiting for a mid-stage answer retains the execution slot while it retains its VM. Runs at approval gates release the slot and their VMs.

Defer task polling, queue collection, a separate triage agent, multiple repositories or concurrent runs, Linear writes, GitHub automation, PR babysitting, automated merge, an external-action outbox, automatic worker reattachment, guest command journals, supervisor epochs, schedules, watchdogs, digests, dedicated monitor/review panes, and remote execution. Add them when regular use demonstrates the need. There is no general workflow engine, connector framework, or multi-package architecture in the first release.

An optional Telegram bot for human questions and steering is a small follow-up after the local flow works. It is specified below, but is not a prerequisite for the core release.

smol guests are Linux environments, initially arm64 Linux on this host. A required check that needs macOS, another architecture, secrets, or an unsupported service remains unavailable; the task cannot pass it. An additional runner is later work.

## Component research baseline

During the initial inspection, the machine had Herdr `0.9.1` and Pi `1.0.0`. Neither `smol` nor `smolvm`, nor Rust or Cargo, was on PATH. This does not establish whether an SDK or toolchain is installed elsewhere. No dependency was installed during specification work.

| Component | Inspected source | Use |
| --- | --- | --- |
| Herdr | `herdrdev/herdr` at `3d9d2b18dab139ba226ebc5a1c9a9f2c9c3ee4df`; 0.9.1 docs | Workspace layout and terminal presentation |
| Pi | `earendil-works/pi` at `18336987add9a3966f338d7c6617e782b58cd91f`; coding-agent package 1.0.4 | In-process SDK sessions, explicit resources and tools, session persistence, and events |
| smolmachines | `smol-machines/smol` at `ab094b9e7abed6dc4b75a9fd43ceb5f541219db5`; Node package 1.23.1 | Local VM execution and file transfer |
| linear-tui | `k1-c/linear-tui` at `fa79ffed365c2deff1916022abe8652989682216`; 0.13.0 | Task selection and JSON reads through the existing Rust binary |
| Builder Factory skills | `BuilderIO/skills` at `530d9eee0453be9672960ef7b0a265c949cd8b08` | Selected planning, review, and human-decision guidance |

These are research baselines, not a tested compatibility matrix. The installed Pi is older than the inspected source. Pin compatible releases and hashes during the compatibility milestone; do not install floating versions during a run.

References: [Herdr plugin contract](https://github.com/herdrdev/herdr/blob/3d9d2b18dab139ba226ebc5a1c9a9f2c9c3ee4df/docs/versions/0.9.1/website/src/content/docs/plugins.mdx), [Pi SDK](https://github.com/earendil-works/pi/blob/18336987add9a3966f338d7c6617e782b58cd91f/packages/coding-agent/docs/sdk.md), [smol types](https://github.com/smol-machines/smol/blob/ab094b9e7abed6dc4b75a9fd43ceb5f541219db5/sdk/node/types.ts), [linear-tui CLI](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/docs/cli.md).

## Architecture and trust boundaries

```text
Herdr workspace
  ├── linear-tui                 task selection and human editing
  ├── Pi factory conversation   commands, plans, questions, review
  └── factory serve             foreground supervisor and progress output
               │ private local command socket
               ▼
One TypeScript supervisor process
  ├── Concrete workflow functions and approval checks
  ├── Pi SDK sessions and sandbox tools, in process
  ├── Read-only linear-tui wrapper
  ├── Local Git/artifact handling
  ├── SQLite state and artifact files
  └── Small smol local wrapper
         ├── planning or implementation VM
         └── fresh verification VM, also used for reviewer checks
```

The supervisor owns execution and approvals; Herdr owns presentation. Closing the conversation or status view does not cancel or approve a run. Closing the foreground supervisor is an interruption. A user service can be added later if keeping a foreground pane becomes inconvenient.

Use one private Unix socket for CLI and Pi operator commands, with a `0700` parent directory, restricted socket permissions, bounded messages, and timeouts. No public HTTP server, separate worker processes, or worker RPC protocol is needed. Pi sessions call the supervisor's bounded tool handlers directly. The model-visible tool registry contains no approval, publication, or merge tool.

Pi runs as trusted host code, with model credentials on the host. All model filesystem and process tools operate inside the assigned VM. Use an explicit resource loader and an explicit tool list; never discover executable extensions, MCP servers, settings, or hooks from a target repository. A failed sandbox or tool adapter stops the stage, with no host-execution fallback.

The operator's factory Pi profile uses the same restrictions. Its human command handlers may submit approvals, but its model cannot invoke those handlers as tools. General-purpose Pi sessions are a separate operator choice.

This boundary does not protect against a compromised operator account or malicious trusted plugin. Herdr 0.9.1 allows same-user processes to read panes and send text or keys, so another host agent could drive an approval command. Treat control of the account and Herdr session as part of the approval trust boundary. A user-presence factor is later hardening.

## Operator experience

Use `make up` to start the configured factory workspace, with `factory serve` running in a Herdr pane. Select an issue in linear-tui, then use the factory conversation to request a plan. Resolve and display the exact issue identity and repository; a stale view cannot silently select a different task. An explicit issue identifier or URL works if reading the current selection is unavailable.

The planner inspects a repository snapshot in a VM. Trusted code runs the registered baseline checks. The operator reviews the plan's scope, acceptance criteria, commands, environment, budget, and any exceptions, then approves that exact version. Implementation, verification, review, and bounded repair run sequentially. Questions and failed gates appear in the conversation and status output.

Human questions are persisted with a request ID, run/stage and plan/candidate context, and pending status before they are displayed. An answer resolves only that current request and is stored with the run; it cannot implicitly resume a paused or cancelled run. Store steering and review comments too, and apply them at a safe agent boundary. These records support the local conversation and the optional Telegram bot without a separate decision-queue service.

At the final gate, display the actual diff, required check results, and review findings from stored artifacts. The operator can request changes or approve the exact candidate for manual integration. The factory provides the candidate commit and instructions for publication and merge. It does not push, merge, or change the Linear issue.

The commands below are the factory API, not upstream commands. See
[compatibility.md](compatibility.md) for the validation status of live integrations:

```text
factory doctor
factory register <repository-path>
factory serve
factory plan <issue-identifier-or-url>
factory plan current
factory status [run-id]
factory approve <run-id> --plan <plan-hash>
factory approve <run-id> --candidate <evidence-hash>
factory revise <run-id> --message <comments>
factory answer <run-id> --request <request-id> --message <answer>
factory steer <run-id> --message <instruction>
factory pause <run-id>
factory resume <run-id>
factory cancel <run-id>
```

Expose the relevant commands as thin `/factory ...` handlers in Pi. `status` reports stage, elapsed time, spend estimate, blocker, and artifact paths; it replaces a custom monitor and digest. A minimal Herdr manifest arranges the panes. Custom pane metadata and branch-association integrations can wait.

`pause` stops new work and allows a bounded grace period for the active command; it does not promise a live VM checkpoint. `cancel` stops execution and prevents continuation. `resume` is explicit and rechecks approval, current task and repository context, budgets, and absence of old execution. A cancelled run cannot resume.

Approval views are rendered by trusted code from the stored plan or candidate. Agent summaries cannot grant approval. Show verification commands, paths, or network settings outside the registered profile separately. Human steering within the approved scope can continue the run; material scope or permission changes require a revised plan and approval.

## Concrete workflow and approvals

Implement one transition table, concrete stage functions, and schemas for plans, candidate manifests, check results, and review findings. There is no stage DSL, workflow loader, graph framework, or generic stage plugin system. Keep permissions and limits in the functions that perform the work. Test the two gates and bounded repair directly.

```text
planning → awaiting_plan_approval → implementing → verifying → reviewing
                                      ↑              │           │
                                      └── repairing ─┴───────────┘
review passed → awaiting_merge_approval → ready_for_manual_merge
```

Additional statuses are `awaiting_input`, `paused`, `interrupted`, `failed`, and `cancelled`. Record provisioning as stage progress rather than another workflow state. Intake and basic triage are part of planning; candidate packaging is part of finishing implementation.

| Gate | Required record |
| --- | --- |
| Plan approval | Task/repository identity, base commit, plan hash, scope, acceptance criteria, check profile and baseline, environment, budget, and configuration snapshot |
| Begin implementation | Valid unrevoked approval, unchanged material scope, healthy sandbox, available budget, and no other executing run |
| Verification passed | All required check results and acceptance evidence against the frozen candidate |
| Review passed | A separate reviewer session tied to that candidate, with no unresolved blocking findings |
| Candidate approval | Exact candidate, observed target/base context, diff and evidence hashes, and human identity/time |

Returning a plan with comments produces a new plan version. Requesting changes at the final gate produces another candidate that must pass verification and review again. A changed candidate invalidates its approval and all candidate check results. A changed target branch requires renewed integration checks and approval for the new context before using the factory's approval for integration. The manual integrator is responsible for checking the current destination; the factory does not enforce a remote merge operation in this release.

At most two automatic repair rounds are allowed per approved plan. Exhaustion waits for the operator. A human-requested additional round is explicitly authorized by that request, remains subject to the budget, and does not expand scope automatically.

`ready_for_manual_merge` means factory preparation and human candidate approval are complete. It does not mean the code was merged, CI passed, a task was closed, or anything was deployed. Keep delivery status unconfirmed unless a later delivery integration verifies it.

### Pi sessions

Use the coding-agent SDK directly through a small module. Let Pi manage its session files, transcript persistence, compaction, and model events; SQLite stores session references and workflow results. Do not build another conversation store or scheduler around Pi.

Create one persisted session per role and attempt, with host-owned settings and resources. The planner has read/list/search tools only. The implementer has bounded VM read/write/edit/search/execute tools. The reviewer has read tools and can request trusted checks against the frozen candidate, but cannot modify the implementation or approve it. All roles may request human input.

Before a model turn, compare the active tool set with the role's explicit expected list. Extra host tools or failed configuration stop the stage. Tool handlers use argv and structured inputs, never host shell interpolation. Host artifact reads use validated artifact IDs rather than model-supplied host paths.

Selected Builder guidance can inform the role prompts at a pinned revision with license and provenance. Adopting a prompt does not require implementing its collection, babysitting, watchdog, digest, or scheduling processes. [Builder Factory guide](https://github.com/BuilderIO/skills/blob/530d9eee0453be9672960ef7b0a265c949cd8b08/docs/factory/README.md).

## Sandbox, candidates, and verification

Use a small wrapper around the smol local operations actually needed: create, readiness, execution, file transfer, confirmed termination, and deletion. No backend selection, capability framework, RAM checkpoint, or remote migration contract is needed yet.

Registration defines an environment profile (pinned image, toolchain, dependency command, allowed guest environment, and dependency egress) and a check profile (ordered required and optional verification commands). Support Pi subscription authentication through an explicit host OAuth credential-file reference, without requiring an API key. The operator may set the per-run dollar cap to `null` for subscription use; turn, time, output, disk and repair limits still apply. Track token usage, and distinguish API-equivalent cost estimates from actual subscription charges. A numeric cap reserves conservative estimated spend before each request. Start with fixed worker limits, proposed as 2 vCPUs, 4 GiB RAM, bounded disk, a 10-minute command timeout, a 45-minute stage timeout, and a 2-hour active execution ceiling. These are adjustable; waiting for a person does not consume active execution time. With one executing run, a resource scheduler and global daily-budget service can wait.

For planning, import an immutable base snapshot into a guest-local repository, prepare dependencies under the registered network policy, then disable execution egress. Run baseline checks through trusted code. Cache the baseline by base commit, image/toolchain, environment and check profile hashes; reuse it only when those inputs match. Store the plan and baseline before deleting the planning VM at the approval gate.

After plan approval, provision implementation from the same base and profile. Export a candidate and validated content manifest. Host Git operations use a factory-owned repository, controlled configuration, disabled hooks, and explicit argv. Do not execute checkout filters or repository helpers from target content on the host. Never reset, stash, or repurpose the operator's checkout. Validate paths, symlinks, submodules, binary sizes, and Git metadata before importing guest artifacts. Trusted code creates the candidate commit with controlled author/committer metadata; do not trust guest-authored commit objects. Use the file API for binary transfer and verify byte length and content hashes.

Do not mount the operator's home, original checkout, shared worktree metadata, SSH agent, credentials, container socket, factory socket, or Herdr socket. Repository package scripts, hooks, and tests execute only in guests. Keep model and Linear credentials on the host.

Default execution egress is disabled. Dependency bootstrap can use an explicit registry allowlist. Validate the pinned local engine's network restrictions in compatibility tests, including host/private-network access, IP literals, IPv6, DNS, and redirects. An allowlist is not proof against exfiltration, so avoid broad wildcards and keep secrets out of guests. A missing dependency stops the run for a decision; the agent cannot reopen egress. Approved reprovisioning can add it.

Verify in a fresh VM reconstructed from the approved base plus the candidate and registered environment. Trusted code runs the commands and records argv, working directory, environment/image identity, candidate, times, exit results, and bounded logs. The implementation agent's claimed checks are supplementary.

Distinguish preexisting failures, introduced failures, skipped checks, and infrastructure failures. A preexisting failure needs a matching baseline result and an explicit approved acceptance policy; it is not an automatic pass. A task with no automated tests needs another approved verification method. Changes to tests and check definitions are visible in the diff, and acceptance checks are selected before implementation.

The reviewer gets the task, approved plan, diff, source, and verification records in a separate session. It may use the fresh verification environment for additional checks without a third reviewer VM, provided the candidate source remains frozen. Findings include location, severity, impact, and proposed correction. A different reviewer model is optional. Separate context helps, but is not a guarantee against shared blind spots.

Every candidate change reruns all required checks and review. Do not implement selective evidence invalidation. Path-scope validation, candidate integrity, and a configured secret scan also gate presentation for final approval. Delete factory-owned VMs at human approval gates after artifacts are safely stored; a change request reprovisions from the base plus saved candidate. A run waiting for a mid-stage answer can retain its VM until explicitly paused or cancelled.

## Read-only Linear integration

Use the pinned upstream linear-tui binary unmodified, through an absolute path, argv arrays, a minimal environment, schema parsing, and bounded output. Read the selected context and issue using `context --json` and `issue show --json`. No task lists, collection loop, mutations, or TUI keystroke automation are required. Preserve `unavailable`, `partial`, and `stale` outcomes instead of treating missing data as an empty task. [CLI contract](https://github.com/k1-c/linear-tui/blob/fa79ffed365c2deff1916022abe8652989682216/docs/cli.md).

Store issue identity, URL, source timestamp/hash, and organization/team/issue UUIDs where returned. Scope intake to a configured team, an exact project URL, or both. Resolve project identity through the read-only JSON CLI, validate its returned URL against the configured organization/project, and bind issues to its UUID. One organization remains the active linear-tui account while the factory runs. Parse URLs before invocation and reject another organization; compare returned identities with the stored task. Re-read at approval/resume boundaries and surface material task changes. Serialize adapter calls. Disable the TUI control socket if current-context reads work without it; otherwise use explicit issue selection initially.

The [linear-tui security review](linear-tui-security-review.md) remains the record of known findings. Its hardening work is deferred for this read-only first release, which supersedes its initial adoption recommendation only within this scope. Single-organization operation and private adapter directories reduce exposure but do not fix account-selection or TUI/CLI token-refresh races. Before adding unattended writes or multiple organizations, revisit the review and require the corresponding fixes or validated mitigations. Preserve the Rust client rather than duplicating it in TypeScript.

## Persistence and explicit recovery

Use local SQLite with transactions, foreign keys, a schema version, and a single writer. Keep private state/artifact directories and database/session files restricted to the operator. A lifetime OS file lock prevents a second supervisor from starting.

Persist the task/configuration snapshot, run state and limits, stage attempts/results, human approvals and requests, VM identity, and artifact references in a small storage module. Log useful state changes without building event sourcing or a replay engine. Persist stage intent before starting and completed outputs before advancing. Pi owns transcripts; files hold diffs, candidates, and check logs.

On supervisor restart, mark unfinished executing stages interrupted and leave them stopped. Before restarting a stage or starting another executing run, inspect and terminate the old factory-owned VM and confirm that its commands can no longer execute. If termination or ownership is uncertain, block execution. Use stable recorded VM identities and factory ownership labels; never clean up an unrelated machine. The exclusive lock alone does not prove old guest execution stopped.

Resume only on an explicit operator command after validating the stored approval and current context. Provision a fresh VM from the base plus the last fully exported, validated candidate. An incomplete implementation stage may lose all work since that candidate; redoing work is an accepted first-release tradeoff. Unknown commands are not retried inside an old VM, and old partial outputs are not promoted to evidence. If the base/context changed materially, return to planning. Unchanged fully completed stages may be reused when all recorded inputs still match; a changed candidate reruns checks and review.

Paused, cancelled, and human-blocked runs stay stopped across restarts. No detached worker reattachment, supervisor fencing epoch, guest operation journal, or automatic effect replay is required. These belong with a later automatic-recovery feature.

Use simple operator-invoked cleanup for unreferenced artifacts, protecting pending approval artifacts. Automated retention policies and disk-pressure management can wait; enforce disk/output bounds on each run. Holding a macOS power assertion while executing is a small convenience; forced sleep is handled as interruption when execution status cannot be confirmed.

## Optional Telegram human channel

Use Telegram for factory questions, requests for human review, answers, and steering. Its official [Bot API](https://core.telegram.org/bots/api) provides HTTPS/JSON messaging and long polling through `getUpdates`. Implement one `telegram.ts` module inside the supervisor using the runtime's HTTP client. No extra messaging process, public webhook, tunnel, hosted relay, or general connector framework is needed.

Create a dedicated bot through [BotFather](https://core.telegram.org/bots/faq#how-do-i-create-a-bot), store its token as a host credential reference, and explicitly configure the operator's numeric user ID and private chat ID. The operator starts a conversation with the bot before notifications are enabled. Validate those IDs from received updates; usernames, display names, and message text cannot establish identity. Keep the token outside model context and guests, and redact it from HTTP request URLs and errors. Only the supervisor sends to the configured chat; the agent cannot select recipients or send arbitrary messages.

The supervisor stores a pending human request before sending a notification. Messages identify the run and request, explain the question or review needed, and give compact reply instructions. Review requests contain brief summaries and check outcomes; full diffs and sensitive details stay local. Telegram bot conversations are cloud chats, without end-to-end encryption. [Telegram encryption explanation](https://telegram.org/faq#q-how-are-secret-chats-different).

```text
Factory F-12, question Q-3: should this endpoint retain the old response field?
/answer F-12 Q-3 <your answer>

Factory F-12: candidate C-4 is ready for your review.
/changes F-12 C-4 <your comments>
Inspect and approve C-4 in Herdr.

/steer F-12 <instruction>
/status F-12
/pause F-12
```

Map those commands to the existing local human-input handlers. A reply to a recorded bot message may supply its run/request context automatically. Small [inline buttons](https://core.telegram.org/bots/api#inlinekeyboardmarkup) can offer predefined answers, request changes, or pause; button references resolve to stored request/candidate records and are validated exactly like text replies. Free text must be tied to a current request or explicit run before it affects a session. It never executes a shell command or grants approval.

Reject obsolete request/candidate references and commands for cancelled runs. Apply steering at a safe agent boundary; expanded scope, network, or budget returns to the local approval gate. The initial bot cannot approve a plan or candidate, publish, or merge. Remote approval can be considered later with explicit binding to the displayed plan/candidate hash.

Run a single bounded long-poll loop, with timeouts and backoff. Persist each processed `update_id` and accepted answer, steering, or request resolution transactionally before advancing the polling offset. Duplicate updates must not apply an instruction twice. On restart, use the saved offset and recheck current request/run state; an old button or delayed reply cannot revive obsolete work. These are small input records in the existing database, not a new event system.

Notifications are best effort. Failed or uncertain sends leave the request visible locally and permit an explicit resend; sending a message or pressing an unrelated button does not resolve the request. Questions requiring answers keep the run waiting. Telegram retains unreceived bot updates for at most 24 hours, so long outages may lose replies; show pending requests locally and allow the operator to answer again. The Mac and supervisor must be running and connected for interactive execution. [Update delivery and offsets](https://core.telegram.org/bots/api#getting-updates).

This remains an optional follow-up to the local workflow. Bot creation, token/recipient configuration, and live messaging are setup work when the feature is implemented; none has been performed during specification work.

## Package and configuration

Use one TypeScript package with modules, a thin Pi extension, and a minimal Herdr manifest:

```text
Makefile
src/
  cli.ts
  supervisor.ts
  workflow.ts
  storage.ts
  pi.ts
  smol.ts
  linear.ts
  git.ts
  artifacts.ts
  telegram.ts      optional follow-up
  prompts/
pi-extension/
herdr/
scripts/          small setup and workspace-launch helpers, if needed
tests/
docs/
```

Keep configuration as validated data: repository/base branch, Linear organization and task scope, environment and checks, model selection, time/resource/spend limits, and private state location. Store the approved snapshot with each run. Repository content cannot expand authority or install host code. Record the factory version, image digest, and relevant configuration/prompt hashes for reproducibility; upgrades of an unfinished run require explicit restart/revalidation, not a migration framework. Credentials are explicit secure-provider references, not indiscriminately inherited shell environment.

Split packages, introduce a provider interface, or support another workflow only when an actual second consumer or implementation requires it. Keep later features as short follow-up notes rather than reserved packages and schemas.

## Makefile setup and operation

Ship a root `Makefile` as the supported entry point for standing up the whole local factory. From a fresh checkout on the supported Mac, the documented path is `make setup`, supply the repository configuration and credentials, then `make up`. Project-controlled installation, build, image preparation, and workspace startup must be covered by these targets; the operator should not need to assemble the system with separate ad hoc commands.

| Target | Behavior |
| --- | --- |
| `make help` | List the targets and required configuration |
| `make setup` | Check host prerequisites, install/build pinned project dependencies and integrations, prepare the pinned guest image, and create sample configuration and private state directories without overwriting existing settings |
| `make doctor` | Check configured tools, credentials by reference, image availability, repository/task scope, and permissions; report actionable failures without printing secrets |
| `make up` | Build as needed, validate configuration, initialize/migrate local state, and open the Herdr workspace with the foreground supervisor, linear-tui, and factory Pi profile; wait for supervisor readiness and report the workspace/state location |
| `make down` | Stop the factory-owned supervisor and active guest execution in a bounded, confirmed way, preserve saved state/evidence, and mark executing work interrupted for explicit resume; paused and waiting states remain intact |
| `make check` | Run type checking and the automated checks appropriate to the implemented milestone |

Keep recipes thin: call the package's commands or small scripts rather than implementing another orchestrator in Make or shell. Setup is repeatable and uses pinned artifacts and lockfiles. Repeated `make up` reuses the existing factory-owned workspace/supervisor for this installation; it must not create a duplicate supervisor or resume interrupted tasks. Startup failures return nonzero with a clear cause and clean up only resources created by that invocation. `make down` never deletes saved runs, credentials, or unrelated panes/VMs.

Document the minimum OS/toolchain prerequisites and human account/configuration steps. Model and Linear authentication remain explicit user setup; when Telegram is enabled, bot creation and token/user/chat configuration are also explicit. `make up` starts its in-process polling along with the supervisor only when configured, and disabled Telegram does not block the local workflow. Bring-up starts the environment, not a task, approval, publication, or merge.

## Security essentials

- Treat issue text, repository instructions, source, and tool output as untrusted inputs; they cannot grant permissions or approve work.
- Load only trusted pinned host code, and keep all repository execution and model filesystem access inside guests.
- Keep host credentials and control sockets outside guests; do not downgrade isolation on failure.
- Validate imported/exported artifacts and bound file sizes, disk, logs, retries, messages, runtime, and model spend.
- Redact secrets and sanitize terminal controls after decoding external data before displaying it.
- Bind approvals and verification to actual revisions, keep review separate from implementation, and fail explicitly on missing evidence.
- Check cancellation and approval validity before starting new work, and confirm old execution has stopped before restarting.

## Milestones and acceptance

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 0 — Compatibility | Pin Pi/smol/linear-tui versions; provide `make setup`, `make doctor`, and `make check`; prove a local VM, forwarded tools, source transfer, termination, and the JSON read fields needed | Isolation, tool-set, task-identity, transfer-integrity, and permission checks pass through the Makefile targets |
| 1 — One task | `make up`/`make down` for the complete workspace; manual issue selection through approved plan, implementation, fresh verification, separate review, and candidate approval inside Herdr | A fixture task produces a local candidate with reproducible evidence and manual integration instructions after Makefile bring-up |
| 2 — Usable first release | Bounded repair, human answers/steering, pause/cancel, persistence, explicit restart, and simple cleanup | Interrupted work stays stopped and can restart safely from a saved candidate; regular single-task use respects approvals and limits |
| Optional — Telegram | One bot/private chat for questions, review comments, and steering, using in-process long polling | User/chat allowlist, text/button references, duplicate/obsolete updates, saved offsets, offline/restart behavior, and local fallback pass; approvals remain local |

Required core acceptance scenarios:

1. A malicious ticket asks for host credentials or self-approval: tools and approval both deny it.
2. A repository contains an executable Pi extension or configuration: host discovery never loads it; guest commands cannot reach the host checkout or control sockets.
3. A second supervisor or executing run is refused. Restart cannot proceed while old guest termination is unconfirmed.
4. A selected issue resolves to a different identity/organization, or data is unavailable: the run stops instead of guessing.
5. A completed stage survives supervisor restart; an unfinished stage becomes interrupted, with no blind continuation or promotion of partial evidence.
6. Pause, cancellation, and pending human questions survive restart. Stale answers cannot resume changed or cancelled work.
7. A changed plan or candidate invalidates its approval; changed candidates rerun all required checks and review. Human change requests return through those gates.
8. Implementation alters tests to hide a defect: the diff exposes the alteration and the preselected acceptance method still applies.
9. Missing tests, macOS-only checks, or infrastructure failures remain explicit; missing evidence never passes.
10. Time/spend/disk/output bounds stop work predictably and retain saved evidence; terminal control sequences cannot drive the operator's terminal.
11. Human steering within scope is accepted at a safe boundary; expanded scope/permissions require another plan approval.
12. A candidate is reported as ready for manual merge, never as merged, deployed, or synchronized to Linear.
13. On a fresh checkout with the documented host prerequisites and user configuration, `make setup` and `make up` bring up the complete local factory. Repeating them preserves configuration and creates no duplicate supervisor; `make down` confirms execution stopped and preserves evidence. Missing credentials or a failed component produce an actionable nonzero result, never a partially ready workspace reported as successful.

Record enough to operate the tool: stage and repair count, elapsed/active time, model usage and estimated spend, check results, and interruption reason. Measure VM startup and forwarded tool latency in the compatibility spike; a metrics pipeline and UI latency objectives can wait.

Follow-ups, each with its own concrete scope: automated publication/merge and Linear writes with operation receipts/reconciliation; automatic recovery if restarting work becomes costly; multiple repositories or scheduling if manual selection becomes limiting; and a remote provider when remote execution is actually needed. Add an outbox, fencing, or capability framework alongside the feature that requires it.

## Approval boundary

This revised specification defines the lightweight implementation target. Building it does not authorize live task writes, recurring jobs, code publication, automated merge/deployment, or Telegram bot setup and messaging. Those require their own concrete scoped configuration if added. The first release ends with an approved local candidate and human integration.
