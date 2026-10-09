.PHONY: help setup doctor validate init up down check build install
help:
	@node scripts/help.mjs
setup:
	@node scripts/with-lock.mjs --supervisor-lock node scripts/setup.mjs
build:
	@npm run build --silent
doctor: build
	@node dist/src/cli.js doctor
validate: build
	@node scripts/with-lock.mjs node dist/src/cli.js validate
init: build
	@node dist/src/cli.js init $(REPO)
up: build
	@node dist/src/cli.js up
down: build
	@node dist/src/cli.js down
install: build
	@node dist/src/cli.js install
check:
	@node scripts/with-lock.mjs npm run check
