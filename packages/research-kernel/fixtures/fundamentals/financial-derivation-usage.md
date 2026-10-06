Run the existing offline CLI from the repository root:

```sh
npm run research:fundamentals -- --input packages/research-kernel/fixtures/fundamentals/financial-derivation-synthetic.json
```

`buildFundamentalOfflineDiagnostic` accepts optional `financialStatements` and returns their derivations alongside the existing snapshot and peer comparison. `deriveFinancialStatements(reports, asOf)` is also exported from `@mms/research-kernel`. Inputs without financial statements retain the previous output. Supplied and derived financial observations for the same issuer/quarter require explicit source reconciliation.

Each statement identifies an exact revision and declares a source URI/SHA-256, publication evidence, and independently known availability evidence with timezone timestamps. These references must identify the archived version; fiscal dates, today's fetch time and placeholder hashes are not substitutes. The adapter validates declarations; the input owner must verify archived bytes and publication/availability evidence. The included synthetic archives have byte hashes checked by the focused tests.

Amounts declare currency, currency units and scales (1, 1,000 or 1,000,000) individually. No FX conversion is performed. The accounting basis must evidence total-entity income and equity under consolidated or separate accounts, including both explicitly dated opening and closing balances. Parent-attributable income must first be reconciled to the declared basis. Calendar-quarter end dates and flow start/end dates must match. Expense sign conventions are explicit; missing inventory/debt is unknown, and negative or zero denominators are unavailable.

YTD flows after Q1 require the explicitly pinned latest available prior quarter with the same currency, accounting scope and evidenced restatement cohort. The adapter never silently selects a different prior revision. ROE/ROA and asset turnover use single-quarter flows divided by average opening/closing balances, without annualization. Asset turnover here is **quarter turnover**, not TTM turnover. Peer comparisons exclude incompatible measurement/accounting bases from each metric's valid denominator.

The synthetic example has 5 statements, 8/8 target metrics and 3 valid peers per metric. Target Q2 net income is 120,000 TWD; ROE is 9.230769% with a 1,300,000 TWD average-equity denominator, ROA is 5% with a 2,400,000 TWD average-assets denominator, and free cash flow is 100,000 TWD. These are arithmetic examples, not trading results. Expected values are preserved in `financial-derivation-synthetic.expected.json`.

`legacy-financial-availability.synthetic.json` preserves the old artificial availability cases. Its placeholder hashes and date-only declarations are insufficient evidence; all 8 cases are rejected by the new adapter. No verified public financial statement archive was found locally. The migration provenance file records original source hashes and this limitation. No new data acquisition, quality score, model or trading integration is included.
