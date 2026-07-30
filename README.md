# MoneyMarketStrategies

MoneyMarketStrategies is an auditable strategy-research and personal
decision-context platform. It is not a second general ETF information portal.

The project is beginning as a TypeScript modular monolith. Its initial package
map is deliberately small:

- `@mms/contracts` holds minimal shared identity and diagnostic-mode contracts.
- `@mms/research-kernel` is the boundary for deterministic quantitative
  research code.
- `@mms/experiment-registry` records immutable diagnostic experiment evidence.
- `@mms/research-runner` coordinates deterministic research studies.
- `@mms/strategy-simulator` replays single-symbol, non-overlapping long/cash
  strategies against a cost-matched always-long benchmark.

The current foundation is diagnostic-only and research-only. Historical replay
positions are research evidence, not current trading signals. The platform does
not provide investment advice or trading execution. No production database has
been selected, and the local bootstrap has no configured remote.

## Authority boundaries

Future legacy ports must read pinned Git objects, never the legacy current
working tree. The exact legacy source authority is:

- Repository: `/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System`
- Ref: `refs/remotes/origin/main`
- Commit: `2fc90673cd79b711108e3c7d92cbaa2b6dd461dc`
- Source: `src/lib/research/RealOhlcvRefit.ts`
- Source: `src/lib/research/RealOhlcvValidationProtocol.ts`

The research packages must remain deterministic and independent from UI,
database, and provider adapters. This foundation has no coupling to legacy
SQLite, `outputs/retraining`, runtime paths, or legacy worktree paths.

The next planned vertical slice is the **Research Evidence Kernel**. That
behavior is intentionally not implemented by this bootstrap.
