This registers one hypothesis and a bounded offline replay; it provides no evidence of real profitability. The baseline entry, 40-bar z-score, 20-bar forced exit, risk limits and modeled costs remain fixed. Only discretionary exit is gated on estimated proceeds covering actual paid entry cost. A subsequent price gap or additional partial-fill fees can still produce a loss.

Run from this checkout after the registration commit, using existing dependencies:

```sh
node scripts/runCostCoveredExitExperiment.mjs --availability
node scripts/runCostCoveredExitExperiment.mjs --input packages/paper-trading/experiments/cost-covered-zscore-exit-v1/synthetic-replay.json --output-dir outputs
```

The provided prices are invented synthetic test data. The first Git commit adding `protocol.json` freezes the real observation boundary and implementation hashes. Pre-freeze data are warmup/development, including past prices not yet downloaded. Historical input must use the frozen four symbols and official TWSE STOCK_DAY URI, chronological rows and receipt timestamps before the next event. Source URI/hash and receipt declarations do not independently prove source authenticity or calendar completeness; real results remain inconclusive pending verification and economic coverage. Replay uses the existing event clock: receipt declarations gate ordering and do not prove live quote freshness or execution availability.

Input follows the synthetic fixture schema. No strategy, risk or cost overrides are accepted. Each symbol is limited to 256 rows, and input to 1 MiB, for this lightweight entry. Readable inputs within this bound retain admission/execution rejections; missing/oversized files and protocol failures stop before a replay attempt. Future cumulative inputs retain the original warmup and all available post-freeze observations; investigate missing dates before interpreting results. Larger coordinated work needs a separately reviewed runner change, rather than silently changing this registration.

The immutable input/result files under `outputs/cost-covered-zscore-exit-v1/` retain successful and rejected snapshots. Repeating identical bytes reuses one snapshot; do not pool overlapping cumulative snapshots or count them as independent trials. Existing frozen artifacts, accumulator and journals are not modified.

Win rate uses fully closed trades including breakevens; zero trades returns null, and open trades remain visible in marked equity/exposure. Two-sided Wilson intervals are descriptive under an unverified IID assumption. Effect uncertainty remains unavailable for a single small dependent window. Three symbols and 12 completed trades per arm are minimum collection counts only. Modeled fees/slippage omit unverified sell/dividend taxes, broker minimum fees and corporate actions. No result auto-promotes or returns PASS.
