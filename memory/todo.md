# MMS TW Transaction Cost Sensitivity Study V1 - Plan & Progress

- [x] Phase 0: Environment, repository state, legacy references, base commit/tree, worktree verification
- [x] Create implementation plan artifact
- [ ] Implement `twStrategyTransactionCostSensitivity.ts` in `@mms/research-kernel`
- [ ] Export `twStrategyTransactionCostSensitivity` functions/types in `packages/research-kernel/src/index.ts`
- [ ] Add unit tests in `twStrategyTransactionCostSensitivity.test.ts`
- [ ] Extend CLI `scripts/runTwStrategyResearchStudy.mjs` to support `--round-trip-cost-bps` and output sensitivity study JSON and Markdown
- [ ] Generate 10 bps temporal reference artifacts and run sensitivity run1 and run2
- [ ] Verify 10 bps temporal invariance and byte-identical sensitivity output between run1 and run2
- [ ] Run full test suite and `npm run verify`
- [ ] Create walkthrough artifact and execute local git commit/lifecycle
