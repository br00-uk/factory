console.log(`Local Factory — Apple Silicon macOS, Node 26.5.x, Python 3, Git
  make setup         Install pinned dependencies/tools and prepare the image
  make doctor        Validate factory.local.json, credentials and capabilities
  make validate      Run the registered checks against the base commit in a fresh VM
  make up            Open the complete owned Herdr workspace (no task starts)
  make down          Confirm supervisor/guest execution stopped; preserve state
  make check         Type checking and boundary/workflow tests
  make compatibility Real smol/Pi/tool compatibility checks (no paid model)

After setup, edit factory.local.json and authenticate Linear explicitly.
Use model.authFile for a Pi subscription (budgetUsd: null), or supply the API
key named by model.apiKeyEnv. Keep credentials outside the target repository.
See README.md.`);
