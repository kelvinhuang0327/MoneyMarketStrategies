This is one fixed retrospective development diagnostic, using the already inspected P194 cache. It is not unseen forward evidence and does not change the original frozen cost-covered exit hypothesis. The plan was committed as `54085cc` before any real replay: four frozen symbols, 2026-01-01 through 2026-08-11, 39 earlier warmup rows each, and unchanged parameters/risk/modeled costs.

```sh
node scripts/runCostCoveredExitHistoryDevelopmentCached.mjs --check-inputs
node scripts/runCostCoveredExitHistoryDevelopmentCached.mjs --run
```

The cache-first supervisor verifies original source/plan/input hashes and reuses a completed result without opening Vite or recalculating trades. A fresh checkout invokes the registered serial replay entry. That entry's cached repeat hit EPERM when unlinking its ownership marker; the immutable entry and failed evidence are retained. The supervisor only archives a matching child lock after observing that child's exit, preserving owner metadata and other processes.

Inputs, the registered plan copy, the full result and all 12 raw arm replays live under `outputs/cost-covered-exit-history-development-v1/`. `result-summary.json` records their hashes and concise findings. Do not pool this window with future evidence, sum repeated cached results, omit losses/open positions, or tune on these results.

The aggregate sums four independent TWD100000 capital runs; it is not a shared-risk portfolio. Time-weighted exposure and holding duration use actual filled position endpoints. Benchmark holdings remain open at cutoff, so its completed-trade win rate is null; hypothetical liquidation is separate. Fees/slippage are model assumptions, and taxes, minimum fees, distributions/splits, official calendar/PIT coverage and execution availability remain unverified. Win-rate Wilson intervals are descriptive; this one selected-development window has no independent efficacy/economic-effect interval.
