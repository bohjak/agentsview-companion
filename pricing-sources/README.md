# Pricing sources

The committed YAML files are the durable pricing ledger used offline by builds and
writers. They cover standard text-output API list prices only; batch, regional,
priority/fast, audio, image, reseller, and negotiated prices are intentionally
excluded. Multimodal input is eligible only when the feed exposes one standard
text-token rate and text is the model's sole output modality.

- `make sync-pricing` fetches models.dev, conservatively merges supported
  direct-provider models, and regenerates runtime rates. The same sync runs during
  `make install`.
- `pnpm --filter @token-tally/store sync:pricing` is the equivalent package command.
- Add `-- --dry-run` to inspect a deterministic proposed sync without changing
  committed sources. `-- --provider anthropic` and `-- --catalog-file fixture.json`
  limit/select the catalog but still write unless combined with `--dry-run`.
- `pnpm exec tsx scripts/generate-pricing.ts` generates only from committed sources;
  it never accesses the network. `--check` detects runtime-table drift and stale
  catalog synchronization.

`sync-overrides.json` is the sole place for verified aliases, canonical models absent
from the feed, rate replacements, and exclusions. Canonical additions, replacements,
and exclusions require a reason plus cited `rateSourceUrl` and `rateAsOf`.

A source's `syncedAt` records catalog retrieval and controls offline freshness.

## Provider semantics

| Provider | Standard text selection | Cache read | Cache write |
| --- | --- | --- | --- |
| Anthropic | standard API text tier; optional fast mode ignored | token cache-hit price | standard prompt-cache creation price |
| Google | standard non-batch text tier | cached input price | unavailable: storage is hourly, not a token creation event |
| OpenAI | standard non-batch text tier | cached-input price when published | zero: no explicit cache-write operation |
| xAI | standard non-batch text tier | published value; unavailable when omitted | published value; unavailable when omitted |

To add a provider, explicitly add its direct provider mapping and semantics here;
do not import a reseller catalog. Use `sync-overrides.json` only for verified
canonical additions, aliases, rate replacements, or exclusions. Add a complete
four-component `rates` object, provenance URL/date, and human-readable reason;
partial rates and inferred aliases are rejected.
Per-model `rateAsOf` records rate provenance and is retained for historical models.
Models missing upstream are never deleted. Existing or alias-promoted models that
become ambiguous, tiered, incomplete, or excluded remain in the ledger as
`syncStatus: inactive`; unresolved new models are reported without invented rates.
Inactive entries are omitted from runtime pricing until a complete cited override
resolves them. A complete existing rate for a deprecated model remains active as
`historical` for log/backfill compatibility; deprecated models are never newly
activated. Runtime lookup accepts only an
exact canonical ID or explicit alias; unknown IDs remain `cost_source='unknown'`.
