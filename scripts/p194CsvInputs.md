`data/market/p194-twstock-ohlcv-v1/` holds the existing canonical P194 CSV copy. Its bytes and SHA-256 match the original Stock export; `provenance.json` retains the historical producer/source location and is not a runtime path redirect.

The two historical research CLIs now use this project-local CSV by default, independently of the caller's current directory. Verify the actual input without training, simulations or result artifacts:

```sh
node scripts/runTwStrategyResearchStudy.mjs --check-csv-input
node scripts/runMiQfiisMultiSymbolGeneralization.mjs --check-csv-input
```

The first CLI separates `--csv-repo`, `--csv-ref` (default `WORKTREE`) and `--csv-path` from auxiliary legacy inputs. Explicit old-style `--legacy-repo`, `--ref` or `--csv-path` invocations without `--csv-repo` retain their previous CSV source/ref semantics. Use `--csv-repo <this-project-root>` when choosing legacy auxiliary reports while retaining this managed CSV. SHA-256 checks remain active.

This cutover does not retire the old Stock directory. Its separate P193 report and optional legacy feature-source inputs are still required by some research routes; the detached older MMS checkout also retains CSV test references. Leave the original CSV until those consumers are explicitly retired or updated. No existing performance artifact or historical provenance is rewritten.
