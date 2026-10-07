# Local Factory

A small TypeScript supervisor for human-approved software work inside Herdr.
Pi agents use Linux microVM tools; the original checkout stays untouched. The
output is a local candidate commit with check and review evidence for manual
integration. Linear remains read-only.

The core implementation is under validation. A disposable task has passed
planning, both approval gates, failed checks, two repairs, fresh verification,
and independent review using scripted fixture agents. Real Pi SDK tools and
smol execution are tested separately. A subscription-backed Pi planner has also
inspected real Salesbook source in a VM and stopped at the plan gate, using a
synthetic smoke task. Live Linear operation and the complete authenticated
workspace are not yet verified. The optional Telegram
module is implemented and tested with mocked HTTP, and remains disabled
without explicit configuration. See [the specification](docs/specification.md).
The Makefile/Herdr fixture also produces a local candidate through actual Pi
operator commands, with offline Linear and scripted role agents.

## Bring-up

Use an Apple Silicon Mac with Node **26.5.x** (`.node-version` pins 26.5.0),
npm, Python 3, Git/Xcode Command Line Tools, and a running **Herdr 0.9.1**
session. Run `make up` from a Herdr pane. Setup downloads hash-pinned Herdr,
linear-tui, and smol deletion CLIs locally; it does not replace your running Herdr server.

```sh
make setup
# Edit factory.local.json: repository, base ref, Linear org/team, model,
# credential reference, image and required checks.
.cache/tools/linear-tui auth login
# Use existing Pi /login credentials, or set the named API-key environment reference.
make doctor
make up
```

Setup preserves existing configuration, installs the lockfile, builds the
package, and boots the pinned image to verify its helper runtime. Stop the
factory with `make down` before reinstalling dependencies. Setup and checks
are serialized so native VM assets cannot be replaced during a test.

Model/Linear authentication is explicit. No credentials are included in the
sample. Disable linear-tui's control channel in its user configuration with
`[agent] control = false`; `context --json` reads view snapshots independently.
Use one active Linear account. Issue reads reject another organization/team.

The sample image is Python 3.12 on arm64 Alpine, pinned through Docker's official
public ECR mirror to avoid repeated Docker Hub anonymous pulls. A different repository needs
a digest-pinned Linux/arm64 image containing `python3` and `sh`, with its tools
already installed or an explicit `environment.toolchain` preparation command.
`environment.dependencies` runs registered dependency argv after source import,
using only its configured registry hosts. Preparation cannot change tracked
source. Declared dependency directories must be absent from tracked source;
they are recreated in each VM and excluded from candidates. Before a model or
check runs, the VM restarts with all execution egress denied.
`environment.env` supplies explicit guest values, never inherited host secrets.
Registered dependency directories stay writable for tool caches during frozen
review checks; tracked source stays read-only and those directories are excluded
from candidates. Changes to configuration require `make down` and `make up`;
the running supervisor rejects new work or continuation against changed settings.
Registered checks must clean generated source files, because
verification rejects a changed source tree. Tracked symlinks and Git submodules are
explicitly unsupported in this initial implementation.

[factory.salesbook.example.json](factory.salesbook.example.json) supplies a
pinned Debian image, checksum-verified Go/Node archives, locked Go/npm dependency
preparation and Go/web checks. Supply its repository and Pi credential paths.
`make setup` verifies both tools and dependencies for the configured base. It
does not start a task or invoke a model.

`make up` opens supervisor, Linear, and factory Pi panes without starting a
task. Repeating it reuses the recorded owned workspace. `make down` confirms
the supervisor lock and recorded VMs are gone before closing owned panes;
saved runs, questions, candidates and logs remain in the private `.factory/`
directory. A startup failure returns nonzero rather than declaring readiness.

From another repository, after the factory is installed, use a Herdr terminal:

```sh
export FACTORY_ROOT=/Users/dan/Developer/br00/factory
node "$FACTORY_ROOT/dist/src/cli.js" register "$PWD"
# Configure that repository's Linear scope, environment and checks in
# "$FACTORY_ROOT/factory.local.json"; the Salesbook profile is supplied above.
make -C "$FACTORY_ROOT" setup
"$FACTORY_ROOT/.cache/tools/linear-tui" auth login
make -C "$FACTORY_ROOT" doctor
make -C "$FACTORY_ROOT" up
```

Create or select a Linear issue describing the change and acceptance criteria.
In the factory Pi pane, `/factory plan current` starts planning that issue.
Ordinary chat text does not start a task; explicit factory commands bind
approvals and execution to an issue. State stays in the factory installation;
model work uses VM snapshots of the registered repository.

## Working on an issue

Use the Pi pane's `/factory` commands or the equivalent CLI:

```text
/factory plan current
/factory plan ENG-42
/factory status
/factory approve F-0123456789ab --plan <displayed-plan-hash>
/factory answer F-0123456789ab --request Q-0123456789ab --message <answer>
/factory steer F-0123456789ab --message <instruction-within-approved-scope>
/factory pause F-0123456789ab
/factory resume F-0123456789ab
/factory revise F-0123456789ab --message <requested-changes>
/factory approve F-0123456789ab --candidate <displayed-evidence-hash>
/factory cancel F-0123456789ab
```

Outside Pi: `node dist/src/cli.js status`, for example. `status` renders stored
plans, scope, baseline/check results, review, hashes, requests, logs and the
actual diff (up to 64 KB, with its full local path). Candidate approval uses
the **evidence hash** displayed as `candidate.evidenceHash`; the separate
`candidate.hash` identifies source bytes. Changed source discards all checks
and review. Requested changes go through planning and approval again.

After approval, status shows the private candidate repository and commit with
a quoted `git fetch` command. Inspect `git show FETCH_HEAD`, select your intended
destination branch, and integrate manually (for example, `git cherry-pick FETCH_HEAD`).
Check the destination before integrating and publish/merge yourself.

No model tool can approve, publish, merge, contact Linear, or execute host
commands. The operator Pi profile accepts `/factory` commands and disables
model requests, filesystem tools, MCP/discovered extensions, and `!` host
shell execution. Use `/factory steer` or a recorded answer to communicate
with an executing agent.

All free-form instructions retain the current path scope, checks,
network policy, and limits. Expanded authority requires `revise` and a new
plan approval. A steering instruction alone cannot change those controls.

For a Pi subscription, use an explicit host credential file:

```json
"model": {
  "provider": "openai-codex",
  "id": "gpt-5.5",
  "authFile": "/absolute/path/to/.pi/agent/auth.json",
  "maxOutputTokens": 8192
},
"budgetUsd": null
```

Sign in through Pi `/login` first. The file must have mode `0600`; Pi handles
locked OAuth refresh. Only credentials are read from this path; user settings,
extensions and executable model configuration are not loaded. `budgetUsd: null`
disables the factory's dollar cap and API-price reservations. Turn, output,
command and stage limits still apply, as do the subscription's own usage limits.
The default total active execution allowance is two hours (`limits.activeSeconds`).
Waiting for a human answer consumes neither stage nor total active time.
Catalog cost metadata is an API-equivalent estimate, not a subscription bill.
An API key can instead use `apiKeyEnv` in place of `authFile`.

A numeric dollar budget uses pinned Pi catalog prices. Before each model
request, the supervisor reserves the maximum input/context and configured
output cost, including pricing tiers. Reservations are not refunded, so the
reported reserved spend is deliberately conservative; actual usage is also
recorded. Choose a cap that covers your selected model's context size and the
number of turns needed. Unknown pricing refuses execution.

Linear scope can use a `team`, an exact `project`, or both. A project is configured
as `{ "name": "Salesbook", "url": "https://linear.app/neverzero/project/salesbook-fd9671bd1086/overview" }`.
The adapter resolves its UUID using read-only `project show --json`, validates
the returned URL, and rejects issues whose project UUID differs.

Checks are required by default. Mark an advisory check with `"required": false`;
its result remains visible. At least one required verification method is needed,
including an explicit alternative when the repository has no test suite.
Required unavailable checks always block a run. Shell exit codes 126/127 are
reported as unavailable commands rather than test failures.
Checks default to Linux/arm64. Set `"platform": "darwin-arm64"` (or another
supported configuration value) to record a requirement for a different platform;
the first-release runner reports it as unavailable without executing its argv.
`make doctor` rejects required checks for unsupported platforms. A baseline
failure exception cannot waive unavailable evidence.
If guest execution is lost, remaining checks are explicitly recorded as skipped;
completed results and private logs survive the interruption. Each result records
its working directory and environment identity as well as source/image and argv.

A known preexisting failure can have an explicit acceptance policy in the
trusted check profile:

```json
"acceptBaselineFailure": {
  "reason": "Known unrelated defect; preserve its exact exit code and output."
}
```

This policy and the failed baseline are included in the exact plan approval.
The candidate must either pass that check or match the baseline's nonzero exit
code and output hash exactly. A matched failure stays reported as failed, with
`comparison: "preexisting"`; independent review still checks every approved
acceptance criterion. A changed failure remains blocking. The factory keeps
one recent baseline keyed by base/source, environment/toolchain, check profile,
limits and build, and verifies its private log hashes before reuse. Unavailable
baseline evidence is retried rather than cached for reuse.

## Optional Telegram

Create a dedicated bot using [BotFather](https://core.telegram.org/bots/features#botfather)
and start a private conversation with it yourself. Add this section to
`factory.local.json` only when you want messaging enabled:

```json
"telegram": {
  "tokenEnv": "FACTORY_TELEGRAM_TOKEN",
  "userId": 123456789,
  "chatId": 123456789
}
```

Supply the named token using your credential manager. The supervisor checks
bot authentication, absence of a webhook, and the configured private chat
before reporting readiness. It then polls the official
[Bot API](https://core.telegram.org/bots/api#getupdates) in process.

The bot supports `/answer RUN REQUEST text`, `/steer RUN text`,
`/changes RUN HASH comments`, `/status RUN`, and `/pause RUN`. Replies to
recorded question/review messages supply their context automatically. A pause
button also binds its recorded context. Numeric user/chat IDs, current
references, and processed update IDs are checked; usernames never authorize
an action. Approvals, resume, publication, and merge stay local.

Notifications are best effort. An uncertain send does not resolve a question
and is not replayed automatically. Use `/factory resend RUN --request REQUEST`
(or `resend RUN` at an approval gate) to retry explicitly. Pending requests and
accepted replies remain in SQLite. Telegram outages do not stop local commands.
Bot chats are cloud chats, without end-to-end encryption; full diffs stay local.
Live bot creation, authentication and messaging have not been performed here.

## Recovery and verification

Interruptions stop work. On restart, unfinished stages become interrupted,
old owned VMs are inspected/deleted, and nothing resumes automatically.
Answer a saved pending question, then explicitly resume. Paused and cancelled
runs retain their state. Resumption uses a fresh VM from the last completely
exported candidate. Unexported work is lost. Material task/base/configuration
changes, or a changed factory build, require explicit revision/reapproval.

```sh
make help
make check          # type checking, durable gates, real VM/Pi boundary, fixture
make compatibility  # real VM/Pi boundary and fixture only; no paid model calls
node dist/src/cli.js cleanup  # remove unreferenced source artifacts while idle
```

Tests use temporary Git repositories and private databases. The fixture's
scripted roles do not establish model quality or live account compatibility.
See [compatibility findings](docs/compatibility.md) for verified versions,
remaining checks, and implementation limits.
The [acceptance record](docs/acceptance.md) maps the specification's required
scenarios to their current evidence and identifies outstanding live validation.
