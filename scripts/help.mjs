console.log(`Local Factory — Apple Silicon macOS, Node 26.5.x, Python 3, Git
  make setup         Install pinned tools, build, and prove the host sandbox
  make install       Link /factory-init and /factory into every Pi session, and factory onto PATH
  make init REPO=…   Register a repository: detect checks, validate them, start the supervisor
  make doctor        Validate factory.local.json, credentials and capabilities
  make validate      Run the registered checks against the base commit in a fresh sandboxed workspace
  make up            Start the supervisor (detached), or the full Herdr workspace from a Herdr pane
  make down          Stop the supervisor and recorded workspace execution; preserve state
  make check         Type checking and boundary/workflow tests

Fastest path: make setup && make install, then in the target repository run
pi and /factory-init. Model credentials come from Pi /login (model.authFile)
or the API key named by model.apiKeyEnv; Linear needs .cache/tools/linear-tui
auth login. Keep credentials outside the target repository. See README.md.`);
