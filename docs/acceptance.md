# Acceptance evidence

The implementation targets the complete [specification](specification.md).
This record distinguishes boundary coverage from live account validation;
fixtures do not establish that the authenticated Linear workspace works.
Run `make check` inside Herdr to verify the current revision. Pinned components,
live smoke results and remaining integrations are recorded in
[compatibility.md](compatibility.md).

## Required core scenarios

| Spec scenario | Authoritative coverage | Remaining limit |
| --- | --- | --- |
| 1. Host credentials and self-approval denied | `vm.test.ts` checks actual SDK tool lists, absence of approval tools, UID and host-path isolation; `boundaries.test.ts` and `control.test.ts` enforce exact human gates | Model intent is untrusted; denying authority does not depend on recognizing malicious wording |
| 2. Repository executable configuration cannot grant host authority | Actual VM contains an executable Pi extension; trusted loader remains empty. Git fixture proves missing objects cannot run a configured lazy-fetch helper | Trusted installed host code and the operator account remain within the trust boundary |
| 3. Exclusive supervisor/execution and confirmed old termination | OS-lock/socket tests; run-slot refusal; real SIGKILL recovery with recorded ownership and confirmed absence; workspace PID reuse | Unconfirmed deletion blocks execution rather than falling back |
| 4. Exact selected issue and organization | CLI-shaped JSON fixtures reject changed UUID, other organization/project, stale or partial selection; workspace fixture selects an issue through Pi | Live upstream issue/context JSON still needs authenticated validation |
| 5. Completed results and interrupted intent | SQLite close/reopen test preserves completed stage results; real supervisor SIGKILL fixture leaves unfinished work interrupted | Explicit restart accepts loss of work since the last fully saved candidate |
| 6. Pause/cancel/questions across restart | Real-VM recovery tests cover saved questions, stale answers, pause during deletion/export without promoting late evidence, explicit fresh-VM resume, and SIGKILL during pause/cancel cleanup | No live VM checkpoint or automatic continuation |
| 7. Approval and evidence invalidation | Actual workflow rejects wrong/tampered hashes, rechecks baseline logs, revises plans and discards changed-candidate evidence; workspace rejects changed config | Manual integration must recheck its destination after final approval |
| 8. Tests weakened to conceal a defect | Real-VM fixture fails checks, weakens a check, is rejected by independent scripted review, and repairs it within two rounds | Fixture verifies orchestration and evidence; real-model review quality remains to be assessed |
| 9. Missing or unavailable evidence | Required-method schema; real command timeout saves unavailable/skipped results; unsupported macOS check cannot execute or use a baseline exception; reviewer has the same platform guard | Linux/arm64 only; unsupported required evidence blocks the task |
| 10. Bounds and safe terminal output | Real VM allocation, command/background timeout and output-overflow tests; durable model turn/spend refusal; path/size validation and terminal-control stripping | Subscription dollar cap may intentionally be null; other limits remain enforced |
| 11. Scoped human steering | Commands retain trusted config/scope; VM write/export scope checks and exact plan hash enforce authority; recovery and Telegram fixtures exercise saved answers/steering | Expanded authority requires local revision and approval; no model or chat reply can grant it |
| 12. Honest manual delivery | Workflow and Herdr fixture finish at `ready_for_manual_merge`, prove candidate commit contents, expose manual Git import guidance and preserve the original checkout | No push, merge, deployment or Linear mutation is implemented |
| 13. Makefile lifecycle | Actual setup prepares pinned tools/image/dependencies; workspace test invokes `make up/down`, drives Pi commands, reuses PID, rejects changed settings, preserves unrelated panes/evidence/questions and cleans failed readiness | Complete workspace operation with a live authenticated Linear account remains unverified |

## Milestones and artifacts

- **Compatibility:** one pinned TypeScript package, local tool binaries, trusted
  image/toolchain preparation, actual Pi tool forwarding and VM transfer,
  isolation and termination checks exist. Startup/tool latency is measured.
  The outstanding live check is scoped Linear JSON and account identity.
- **One task:** the Makefile/Herdr fixture selects an offline issue, submits
  both approvals through the actual Pi operator pane, and produces a checked,
  independently reviewed candidate with manual import guidance. Separate
  live subscription planning and real Salesbook application baselines passed;
  this combination does not prove a complete model-driven live issue run.
- **Usable operation:** bounded repair, persisted intent/results, answers,
  steering, stop/restart, and operator-invoked artifact cleanup are implemented.
  The real-VM workflow/recovery tests are the acceptance checks for these paths.
  The cleanup fixture preserves pending approval and completed-stage artifacts
  while deleting an orphan snapshot.
- **Optional Telegram:** mocked HTTP checks cover numeric identity, text/button
  references, duplicate/obsolete input, persisted offsets, uncertain sends,
  restart/local fallback and webhook refusal. Approvals remain local. Bot
  creation, account configuration and live messaging have not been performed.

The root `Makefile`, `AGENTS.md`, `.codex/config.toml`, validated example profiles,
thin `pi-extension/index.ts` and `herdr/herdr-plugin.toml` are present. Runtime
state is private SQLite; Pi owns role transcripts; snapshot manifests, commits,
diffs and check logs are local files. README documents host prerequisites,
explicit account setup, subscription credentials, repository registration,
commands and manual operation. These artifacts do not replace missing live
integration evidence.

## Next live validation

The upstream CLI currently reports no OAuth token or API key. The operator must
sign in explicitly with `.cache/tools/linear-tui auth login` and identify a
Salesbook issue. Then validate read-only issue/context identity, run `make doctor`
and `make up`, and exercise a real planning run. Plan and candidate approvals
remain the operator's decisions. No account setup, task write, publication,
deployment or external message is inferred from fixture authorization.
