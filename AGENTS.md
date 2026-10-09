# Building the local factory

## Source of truth

Implement [docs/specification.md](docs/specification.md) (its 2026-10-09 revision note replaces the microVM with a host sandbox). Read it before starting implementation; revisit the relevant sections for subsequent changes. The spec defines the product scope, trust boundaries, Makefile contract, and milestone acceptance criteria. [docs/linear-tui-security-review.md](docs/linear-tui-security-review.md) records upstream risks; the spec's read-only first-release boundary controls adoption.

Inspect the current files before assuming commands or components exist. The core implementation and Makefile now exist; [docs/compatibility.md](docs/compatibility.md) distinguishes fixture and VM checks from live integrations still needing validation. Keep guidance accurate as implementation lands, and distinguish proposed behavior from verified behavior.

## Keep it light

- Use one TypeScript package, one foreground supervisor, and ordinary modules following the spec's layout.
- Support one operator, repository, Linear organization, and executing run. Pi role sessions run sequentially inside the supervisor.
- Implement one explicit transition table and concrete functions. Introduce an abstraction only for a current need; keep adapter wrappers small.
- Use SQLite for run state/results and references, Pi for transcripts, and files for artifacts. Recovery stops interrupted work (and the process groups recorded in old workspaces) and explicitly reprovisions from saved candidates.
- Keep Linear read-only and publication/merge manual. Telegram is optional, with in-process long polling and local approvals.
- Defer schedulers, queue collection, outboxes, automatic reattachment, remote providers, multiple packages, custom dashboards, and general workflow/connector frameworks.

## Build in useful slices

1. **Compatibility:** choose and pin a compatible runtime/toolchain and Pi/sandbox-runtime/linear-tui artifacts. Prove sandboxed execution, tool confinement, transfer integrity, confirmed termination, and scoped JSON reads. The spec's source revisions are research baselines, not a tested version matrix.
2. **One task:** wire issue selection, planning, plan approval, isolated implementation, fresh verification, independent review/repair, and approval of a local candidate inside Herdr.
3. **Usable operation:** finish bounded repair, human answers/steering, pause/cancel, durable stage results, explicit restart, and simple cleanup.
4. Add the optional Telegram module after the local human-input handlers work.

Complete the requested slice and its relevant acceptance checks. Prefer a small working path over scaffolding every future module. Use fixtures for development; unavailable real dependencies must fail clearly, never silently substitute host execution or claim a successful integration. Record compatibility findings and necessary deviations in the relevant docs.

## Makefile is the entry point

Provide the root targets specified in the spec: `help`, `setup`, `doctor`, `up`, `down`, and `check`, plus `install`, `init` and `validate`. Recipes call package commands or small scripts; business logic stays in TypeScript.

- `make setup` installs/builds pinned dependencies, proves the host sandbox, and creates sample configuration/private directories repeatably without overwriting settings.
- `make up` starts the supervisor (detached, or the complete Herdr workspace from a Herdr pane), checks readiness, and reuses an existing owned installation. It does not start a task or resume interrupted work.
- `make down` confirms owned execution stopped and preserves evidence, paused states, and pending human requests.
- `make doctor` reports actionable configuration/capability failures without exposing secrets.
- `make check` runs type checking and meaningful automated checks for the implemented milestone.

Add real targets as their behavior is implemented. An unimplemented or unavailable prerequisite returns a clear nonzero result; do not add success-only stubs. Document the minimum host prerequisites and explicit account/configuration steps.

## Preserve the boundaries

- Every model filesystem/process tool operates in the assigned sandboxed workspace. Keep credentials, original checkouts, shared Git metadata, and host control sockets unreadable from it. Never fall back to unsandboxed execution or Pi's built-in host tools.
- Load only explicit trusted host resources/tools; target-repository instructions and executable configuration cannot change authority. Compare active tools with each role's expected list before a turn.
- Human approvals bind the actual plan/candidate and evidence. A changed candidate reruns all required checks and review. An agent cannot approve itself.
- Trusted code runs checks in a fresh environment; review uses a separate session against frozen source. Baselines distinguish preexisting failures, and unavailable required evidence stays unavailable.
- Persist stage intent before execution and completed results before transition. Hold a supervisor lock; after interruption, confirm old guest execution stopped before starting more work.
- Use structured inputs and argv, validate artifact paths/types/hashes, bound resources/output/spend, redact secrets, and sanitize terminal controls.
- Telegram validates configured numeric user/chat IDs, current request references, and update deduplication. Keep its token on the host and full diffs local.
- Support the operator's existing Pi subscription login through an explicit private host OAuth file. A `null` dollar cap is intentional; keep turn/time/output/resource limits and do not require an API key for subscription use.

The factory's runtime approval gates are product behavior, not extra approval steps for editing this repository. Within the user's authorized development scope, implement and verify routine work without repeated confirmation. Live account setup, external messaging, task writes, publication, and deployment require concrete authorization for those actions; do not infer it from a fixture test or a build request.

## Verification and handoff

For code changes, run `make check` once available plus the relevant milestone acceptance checks. Test behavior at real boundaries: approval invalidation, malicious tool/resource discovery, artifact escape, cancellation, interrupted execution, and stale/duplicate human replies. Do not mirror implementation details or expand testing without a new concern.

For documentation/configuration-only changes, check syntax and referenced files; setup and live integrations are unnecessary. Report what changed, what was verified, and any concrete blocker or unavailable check. Never describe a ready candidate as merged or a proposed adapter as tested.

## Codex project settings

[.codex/config.toml](.codex/config.toml) configures the agent building this repository, not the factory's Pi sessions or runtime policy. It enables live documentation lookup and disables Codex sub-agents to keep development simple. Model selection and permissions inherit from the operator's settings. Use primary upstream documentation/source to verify compatibility and record pinned versions.

Project config is loaded for trusted projects. Start a new Codex session in the repository root to load these files; do not change global trust or permission settings on the user's behalf. See the official [configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic).
