# Compatibility and current implementation

Validated on this Apple Silicon Mac on 6 October 2026:

| Component | Pin | Result |
| --- | --- | --- |
| Node | 26.5.0 | TypeScript build, `node:sqlite`, tests |
| TypeScript | 7.0.2 | Strict build |
| Pi SDK/CLI | 1.0.4 | Explicit resources/tools; registered guest execution tool exercised; actual Herdr operator profile rejects host shell |
| smolmachines/native engine | 1.22.2 | Linux/arm64 VM, unprivileged commands, binary integrity, frozen source, denied egress and confirmed deletion; observed 1 GB filesystem, 512 MB allocation and one CPU |
| smol deletion CLI | 1.22.2 | Direct local record deletion without booting an interrupted guest; checksum-pinned release binary |
| Herdr CLI/server | 0.9.1 | Owned workspace create/get/close and Pi pane interaction tested without focus change |
| linear-tui | 0.13.0 | Hash-pinned binary installed; CLI contract/schema fixtures checked; live JSON issue/context reads require authentication |

The specification's smol **1.23.1** source revision is a research baseline.
That version was not published as `smolmachines` on npm during this build;
the published **1.22.2** package is used and locked instead.

The pinned image is:

```text
public.ecr.aws/docker/library/python@sha256:a4ccdf11e73bd3f74e07f95e63f1b003467bb16cb77e942ddf45476c2cb8467c
```

The installer pins release archive/binary SHA-256 values in `src/install.ts`;
npm dependencies and native assets are pinned by `package-lock.json`.

The latest full `make check` passed all 34 checks in 265.7 seconds after the ECR
profile change. Repeat `make setup` completed Salesbook image/toolchain/dependency
preparation without changing that configuration. No factory VMs remained after
the checks. `make doctor` still exits nonzero with the explicit Linear sign-in
instruction; live account validation is outstanding.

## Findings that affect the implementation

- Image pulling happens inside smol's guest preparation environment. Creating
  an image VM directly with egress disabled fails even after pulling through
  a different VM. Each new VM therefore prepares its image with an explicit
  Docker registry/CDN hostname allowlist, before receiving any source or
  credentials. It then stops, switches the host-side policy to `deny-all`,
  restarts, and receives source. No model can change this policy.
- The 1.22.2 local engine needs `network: true` alongside the preparation
  allowlist to select the `virtio-net` backend. The allowlist probe connected
  to `registry-1.docker.io` and rejected another DNS name, IPv4 public/private
  literals, IPv6, loopback, and the host-side gateway. The denied policy was
  separately tested against those categories and an allowed registry name.
- `make setup` prepares/verifies the image; this does not imply a reusable
  global image cache. Subsequent provisioning may fetch the pinned image again.
- Repeated validation reached Docker Hub's unauthenticated pull limit. The
  example profiles now explicitly use Docker's
  [official ECR mirror](https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/).
  Anonymous manifest reads for both Python pins returned byte-identical SHA-256
  values. Image preparation allows `public.ecr.aws` and its observed layer CDN,
  `d2glxqk2uabbnd.cloudfront.net`; source/model execution still denies all egress.
  Actual ECR guest startup, tools, transfer/export, frozen source and deletion
  passed. This is an explicit profile change, not a silent registry fallback.
  Registries can still be unavailable or rate limited; that remains a clear
  provisioning failure. The pinned SDK does not expose CLI disk-pack creation,
  so no additional pack/restore adapter was added for this release.
- The execution image must supply Python for trusted transfer/freeze helpers.
  No host mounts are used. All model commands run as UID/GID 1000; trusted
  helpers own frozen source as root, preventing reviewer writes.
- Git snapshots reject invalid UTF-8 paths instead of replacing bytes. Host
  reads set `GIT_NO_LAZY_FETCH=1`, using the documented
  [Git environment control](https://git-scm.com/docs/git#Documentation/git.txt-GITNOLAZYFETCH),
  so a missing partial-clone object cannot invoke a target-configured remote
  helper. A real Git fixture proves the helper would run without that control
  and remains untouched during factory reads.
  Guest export also rejects invalid UTF-8 filenames: the actual Linux fixture
  creates such a file and cannot export it as a host candidate.
- A registered check may specify its required platform. Anything other than
  Linux/arm64 is unavailable without executing its command; required checks
  block doctor and planning. The real-VM macOS fixture confirms that a baseline
  failure exception cannot accept this missing evidence. Reviewer tools use
  the same platform guard.
- A test initially failed because setup's `npm ci` replaced native assets
  while tests were using them. Setup/check are now serialized, and setup
  refuses while the supervisor lifetime lock is held.
- SDK `Machine.connect` starts a stopped VM, so it is inappropriate for recovery
  deletion. Recovery now uses the pinned CLI's `machine rm --local --yes`, whose
  [upstream implementation](https://github.com/smol-machines/smol/blob/v1.22.2/src/commands/rm.rs)
  directly deletes the local record. It observes the parent-death reaper before
  deletion to avoid racing the agent's filesystem-sync shutdown. Pause and cancel
  intent survived `SIGKILL` during deliberately blocked cleanup, and the actual
  owned guests were confirmed absent. The matching interrupted-stage recovery
  test passed too. Only the CLI binary is extracted, without its guest rootfs;
  this deletion operation needs no additional boot/runtime bundle.
- A compatibility sample measured 6,356 ms for guest startup/image preparation
  and 12 ms for a forwarded Pi execution-tool call. The boundary test reports
  these measurements; registry/network conditions affect startup time.

The end-to-end fixture uses scripted roles and real microVMs. Its first
implementation fails a registered check; the next attempt weakens that check
to hide a defect, which independent review catches. The second repair restores
the check and passes the acceptance criterion. Both exact human gates are enforced.
It creates a controlled candidate commit in a private bare repository and
leaves the target host checkout unchanged. The actual Pi SDK tool bridge is
tested separately without sending a model request.

A separate live planning smoke used the actual Salesbook repository at commit
`a6a2c8983f219e67d7fe0032e3029d5d2202038b` (559 regular files, 3,891,908 bytes)
and the operator's existing Pi `openai-codex` subscription login with `gpt-5.5`.
Two model requests produced a README-only plan and stopped at the local approval
gate. The task was synthetic, its only baseline established source presence,
and no candidate, publication or Linear mutation occurred. This verifies model
authentication/tool access, not Salesbook's application checks or delivery.
The local configuration explicitly sets `budgetUsd: null` for this subscription.

A separate source/environment validation on the same Salesbook commit passed
`go test ./...`, `go vet ./...`, and the web TypeScript check plus all seven
Vitest tests. It used the Debian Python image and checksum-pinned Go/Node
archives in `factory.salesbook.example.json`, followed by `go mod download`
and `npm ci --ignore-scripts`. Toolchain preparation runs before source import;
dependency preparation runs after import under its registered host allowlist.
Execution egress is denied again before checks and model sessions. This was
application baseline validation, without Linear intake or model implementation.
Private evidence is in `.factory/validation/salesbook-4b627828-e207-492d-b7fd-cc0dff952857.json`.

The Salesbook profile pins Python's Debian arm64 digest
`715a063709d47191add11cccf48b4de0cdf220302070ca78d10c249f721f1da6`,
Go 1.27.1 and Node 26.5.0. Archive hashes come from the primary
[Go download metadata](https://go.dev/dl/?mode=json) and
[Node release checksums](https://nodejs.org/dist/v26.5.0/SHASUMS256.txt).
The trusted Python installer validates HTTPS downloads and hashes before
bounded extraction inside the guest; it does not run repository setup on the host.
Preparation restarts exposed that `/tmp` caches disappear on VM reboot.
Registered persistent caches now use `/var/cache/factory` instead.
The guest Git repository is built from transferred source, with its own index,
objects and controlled configuration; host shared Git metadata is never imported.

The Migratory profile (`factory.migratory.example.json`, 7 October 2026) pins
the same Debian Python image, Go 1.26.5 (hash from the primary Go download
metadata) and `go mod download`, and registers that repository's own gate —
`go build ./...`, `go vet ./...`, `go test -race ./...` — as checks. The
repository is registered and `make validate` exists to prove the profile in a
fresh guest, but validation has **not** run yet: two `make setup` attempts
from a sandboxed agent shell failed at image preparation with
`Get "https://public.ecr.aws/v2/": dial tcp 99.83.145.10:443: connect:
connection refused` while the same host shell reached that address directly.
Run `make setup` and `make validate` from an interactive Herdr pane to settle
whether the sandbox or the registry allowlist refused the pull. The offline
baseline defect this surfaced (one tenancy test failing instead of skipping)
is fixed in Migratory T057.

## Remaining validation

- Live read-only Linear issue/context JSON and active organization identity.
- A real task's model-driven implementation/review and human question loop.
- Full workspace operation with the authenticated upstream Linear CLI. The
  Makefile/Herdr lifecycle now passes an isolated test with explicitly offline
  Linear fixtures and scripted roles, with no model requests: actual
  supervisor/operator startup, issue selection and both approvals through the
  Pi pane, a fresh checked/reviewed VM candidate and manual Git import guidance,
  reuse of the same PID, rejection of changed configuration, preservation of
  unrelated panes and paused questions, and failed-component cleanup. It found
  and fixed empty Herdr command acknowledgements, delayed agent detection, and
  a transient operator status marker. This is not live Linear authentication.
- The pause/deletion boundary now has a real-VM regression: pause after native
  deletion, before the close promise returns, stays paused across restart.
  Explicit resume returns to plan approval. Final candidate approval is offered
  only after VM deletion is confirmed; late completion cannot overwrite pause.
  The same fixture pauses after actual candidate export and confirms that late
  completion cannot promote that candidate, including across restart.
- Credential containment resolves parent-directory aliases before checking that
  the OAuth file is outside the target checkout. Idle cleanup has a filesystem
  regression preserving pending approval and completed-stage snapshots while
  removing an unreferenced snapshot.
- More cancellation stress scenarios and malformed guest
  artifact cases. Pause/question/restart, abrupt `SIGKILL`, confirmed owned VM
  deletion, and real guest output overflow now pass automated tests. The private
  control socket's permissions, invalid-command rejection, duplicate-supervisor
  refusal, and clean shutdown also pass.
- The engine's own command timeout can return a result while leaving the VM
  alive. The wrapper now enforces a host deadline and confirms whole-VM deletion;
  a real command/background-descendant timeout test passes.
- The optional Telegram module now passes mocked HTTP tests for identity,
  reply/button references, duplicate/obsolete updates, offsets, uncertain sends,
  token-safe errors, local fallback and webhook refusal. Live bot configuration
  and messaging have not been performed.

Current narrower support is explicit: no tracked symlinks/submodules,
and all requested changes replan/reapprove. These fail closed rather than
being reported as successful evidence. This document records progress; it
does not certify that every first-release acceptance scenario has passed.

Other repositories need an explicit Linux/arm64 environment and registered
checks. The Python fixture image alone cannot satisfy Salesbook's Go/web checks;
the supplied Salesbook profile now prepares the required tools and dependencies.
Linear CLI authentication is still required before live project/issue reads.
