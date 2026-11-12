SHELL := /bin/bash

.PHONY: install install-tray install-pi uninstall build test check

install:
	@bash scripts/install.sh

install-tray:
	@bash scripts/install-tray.sh "$(CURDIR)"

install-pi:
	@bash scripts/install-pi.sh "$(CURDIR)"

uninstall:
	@bash scripts/uninstall.sh

build:
	@$(MAKE) -C clients/macos-tray build

test:
	@pnpm --filter @agentsview-companion/pi-usage-command test
	@$(MAKE) -C clients/macos-tray test

check:
	@bash scripts/release-check.sh
