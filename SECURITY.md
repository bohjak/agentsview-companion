# Security Policy

This is a public personal project with no ongoing maintenance or support
commitment. Use it at your own risk.

## Supported versions

There are no formally supported versions. The latest commit on `main` is simply
the current public state of the project.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

If you choose to report a security issue, use
[GitHub private vulnerability reporting](https://github.com/bohjak/agentsview-companion/security/advisories/new)
when available. Reports may not be acknowledged, investigated, or fixed.
There is no response-time or remediation guarantee.

## Scope

ToTally's macOS app and Pi extension read AgentsView's unauthenticated local
HTTP API. Connections are restricted to loopback endpoints and redirects are
rejected. The clients do not collect sessions, write an analytics database, or
send usage to an external service.

The primary boundaries are AgentsView's daemon discovery records and API
responses, local UI preferences, and the source symlink loaded by Pi. AgentsView
owns ingestion, storage, pricing, and its own network/telemetry configuration.
