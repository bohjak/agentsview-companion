# AgentsView Companion

Native macOS menu-bar app (**ToTally**) and Pi `/usage` extension for
[AgentsView](https://agentsview.io/). Both clients read AgentsView's local API;
the companion has no database, collectors, pricing engine, or web server.

## Setup

Install and start AgentsView separately:

```sh
brew install kenn-io/tap/agentsview
agentsview daemon start
git clone https://github.com/bohjak/agentsview-companion
cd agentsview-companion
make install
```

On macOS, this builds and installs `/Applications/ToTally.app` and restarts it.
If Pi is present, it also symlinks the `/usage` extension into Pi's extensions
directory. Reload Pi to pick up changes. Install either client separately with
`make install-tray` or `make install-pi`. Run `git pull && make install` to update.

The tray requires macOS 14+ and Xcode Command Line Tools (or full Xcode).
The Pi extension requires Pi running Node.js 24+ and has no runtime packages
to install. Building/testing TypeScript requires Node.js 24+ and pnpm;
run `pnpm install`.

Both clients discover the daemon under `~/.agentsview/`, or
`AGENTSVIEW_DATA_DIR` in their environment. To override discovery, use the
tray's server URL setting or `AGENTSVIEW_URL` for Pi. Only unauthenticated
HTTP(S) loopback endpoints are supported. Neither client starts, configures,
or stops AgentsView. Configure AgentsView's archive-content and telemetry
settings separately.

## Menu bar

The app shows token/cost totals, daily costs, and top models/projects.
**Settings → Include cached tokens** switches between all tokens and
input + output only; costs are unchanged. “Open AgentsView” opens its Usage
dashboard. Launch-at-login and display preferences remain local.

## Pi

```text
/usage
/usage --since=7d
/usage --json --tab=models --since=month
```

Tabs: summary, models, repos (AgentsView projects), daily.
Use arrow keys or 1–4 to switch tabs, `s` to cycle the period, and `q`/Escape
to close. Periods are today, past 7 calendar days, past 30 calendar days
(`month`), or all time (default), in the local timezone. Both clients include
automated and one-shot usage. Pi shows fresh and cached tokens separately.

JSON uses AgentsView's native token fields and integer microdollar amounts,
not the old ToTally SQLite query format. Pricing and incomplete/stale coverage
notices come from AgentsView. Removed: tool/PR tabs, latest-session totals,
`--since=24h` (use `today`), `/analytics doctor`, and `/analytics explore`.

## Development

```sh
pnpm install --frozen-lockfile
make build       # assemble the macOS app without installing
make test        # Pi and Swift tests
make check       # typecheck, tests, shell checks, macOS build
```

Swift tests require full Xcode. The SDK-selection helper handles Command Line Tools versions whose
default SwiftUI SDK requires compiler plugins only supplied by Xcode.

Source lives in `clients/macos-tray/` and `clients/pi-usage-command/`.
Install/build helpers live in `scripts/`.

## Legacy installations and uninstalling

The old store, writers, CLI, web explorer, import/backfill tools, and pricing
sources have been removed from this repository. Historical databases are not
deleted or imported into AgentsView. Existing collector registrations are not
automatically migrated: remove old Pi writer links, Claude/Cursor hook entries,
and the ToTally drain service from older installations before using them again.

`make uninstall` removes the current tray app and this checkout's Pi usage
symlink. It leaves preferences, AgentsView, historical databases, and any old
collector installations untouched.

## Project status

This is a public personal project with no support, roadmap, release cadence,
or compatibility guarantees. Issues and pull requests may not be addressed.
If you depend on it, be prepared to maintain a fork.

## License

MIT — see [LICENSE](LICENSE).
