`data/market/p194-twstock-ohlcv-v1/` holds the existing canonical P194 CSV copy. Its bytes and SHA-256 match the original Stock export; `provenance.json` retains the historical producer/source location and is not a runtime path redirect.

The two historical research CLIs now use this project-local CSV by default, independently of the caller's current directory. Verify the actual input without training, simulations or result artifacts:

```sh
node scripts/runTwStrategyResearchStudy.mjs --check-csv-input
node scripts/runMiQfiisMultiSymbolGeneralization.mjs --check-csv-input
```

The first CLI separates `--csv-repo`, `--csv-ref` (default `WORKTREE`) and `--csv-path` from auxiliary legacy inputs. Explicit old-style `--legacy-repo`, `--ref` or `--csv-path` invocations without `--csv-repo` retain their previous CSV source/ref semantics. Use `--csv-repo <this-project-root>` when choosing legacy auxiliary reports while retaining this managed CSV. SHA-256 checks remain active.

The P193 report and optional feature source now default to private, untracked snapshots under `data/private/stock-research-inputs-v1/`, with a local manifest that pins file size/hash and preserves original source paths. Verify them without reading the CSV or running models:

```sh
node scripts/runTwStrategyResearchStudy.mjs --check-legacy-inputs
```

The private directory is intentionally excluded from Git. A new checkout needs those independently verified local snapshots restored before report/source-dependent research. Missing or changed managed files fail closed; there is no automatic fallback to the old directory. Python source is retained as formula evidence and is never executed. Explicit `--legacy-repo`, `--ref`, `--refit-report-path` or `--feature-source-path` opts into the legacy/custom reader; Git refs read committed bytes without checkout. Historical provenance and performance artifacts are unchanged.

This cutover does not authorize deleting the old Stock directory. The detached older MMS checkout still retains CSV test references. Preserve its HEAD/worktree state and explicitly switch or retire its consumers before removing any old inputs; preserve source restore maps and verify archived bytes separately.
