.PHONY: help setup doctor validate up down check build compatibility
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
up: build
	@node dist/src/cli.js up
down: build
	@node dist/src/cli.js down
check:
	@node scripts/with-lock.mjs npm run check
compatibility: build
	@node scripts/with-lock.mjs node dist/scripts/compatibility.js
