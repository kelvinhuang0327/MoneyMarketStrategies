# Project Context

The product is not a general ETF information portal. Research is
diagnostic-only: there is no investment advice, trading execution, production
database, or Evidence Kernel behavior in this foundation.

Quantitative research packages must remain deterministic and independent from
UI, database, provider, legacy runtime, SQLite, `outputs/retraining`, and
artifact-path coupling.

Legacy source authority is the pinned Git object
`refs/remotes/origin/main` at
`2fc90673cd79b711108e3c7d92cbaa2b6dd461dc` in
`/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System`, limited to:

- `src/lib/research/RealOhlcvRefit.ts`
- `src/lib/research/RealOhlcvValidationProtocol.ts`

Never use the legacy current working tree as source authority.
