"""Reprice saved fills only. Never imports/runs a strategy, engine or lock entrypoint."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

EXPERIMENT = Path('packages/paper-trading/experiments/cost-covered-exit-cost-sensitivity-v1')
ARMS = ('baseline', 'candidate', 'costMatchedBenchmark')
INITIAL = 40000000


def fill_cost(fill, scenario, tax_bps):
    notional = int(fill['executionPriceMinor']) * fill['quantity']
    if scenario.get('useSavedFees'):
        return int(fill['feeMinor'])
    # Integer quarter-bps avoids float monetary rounding; ceil to whole TWD.
    commission = ((notional * round(scenario['commissionBps'] * 4) + 3999999) // 4000000) * 100
    commission = max(commission, scenario['minCommissionTwd'] * 100)
    tax = ((notional * tax_bps + 999999) // 1000000) * 100 if fill['side'] == 'sell' else 0
    return commission + tax


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def calculate(source):
    plan = json.loads((EXPERIMENT / 'plan.json').read_text())
    history_summary = json.loads((EXPERIMENT.parent / 'cost-covered-exit-history-development-v1/result-summary.json').read_text())
    prefix = plan['sourceInputSha256']
    result_path = source / (prefix + '.result.json')
    assert digest(result_path) == history_summary['rawResult']['sha256']
    history = json.loads(result_path.read_text())
    by_symbol = {r['symbol']: r for r in history['results']}
    hashes, saved, sizes, observations = {}, {}, {}, {}
    for symbol in plan['sellTaxBps']:
        for arm in ARMS:
            path = source / f'{prefix}.{symbol}.{arm}.replay.json'
            hashes[path.name] = digest(path)
            assert hashes[path.name] == history_summary['rawReplaySha256'][path.name]
            raw = json.loads(path.read_text())
            saved[symbol, arm] = raw['replay']
            observations[symbol, arm] = raw['observations']
        fills = [f for f in saved[symbol, 'baseline']['journal'] if f['kind'] == 'fill' and f['side'] == 'buy']
        assert all(f['quantity'] == 3 for f in fills)
        sizes[symbol] = [{'quantity': f['quantity'], 'timestamp': f['timestamp'],
                          'executionNotionalMinor': str(int(f['executionPriceMinor']) * f['quantity']),
                          'savedEntryFeeMinor': f['feeMinor'],
                          'savedEntryCashMinor': str(int(f['executionPriceMinor']) * f['quantity'] + int(f['feeMinor']))} for f in fills]
    scenarios = []
    for scenario in plan['scenarios']:
        rows, aggregate = [], {}
        paths = {a: {} for a in ARMS}
        for symbol, tax in plan['sellTaxBps'].items():
            for arm in ARMS:
                replay = saved[symbol, arm]
                fills = {f['fillId']: f for f in replay['journal'] if f['kind'] == 'fill'}
                costs = {i: fill_cost(f, scenario, tax) for i, f in fills.items()}
                trades = []
                for t in replay['tradingStatistics']['completedTrades']:
                    entry = sum(int(fills[i]['executionPriceMinor']) * fills[i]['quantity'] for i in t['entryFillIds'])
                    exit_value = sum(int(fills[i]['executionPriceMinor']) * fills[i]['quantity'] for i in t['exitFillIds'])
                    fees = sum(costs[i] for i in t['entryFillIds'] + t['exitFillIds'])
                    original_fees = sum(int(fills[i]['feeMinor']) for i in t['entryFillIds'] + t['exitFillIds'])
                    assert exit_value - entry - original_fees == int(t['netPnlMinor'])
                    trades.append({'tradeNumber': t['tradeNumber'], 'openedAtTimestamp': t['openedAtTimestamp'],
                                   'closedAtTimestamp': t['closedAtTimestamp'], 'quantity': t['enteredQuantity'],
                                   'entryNotionalMinor': str(entry), 'exitNotionalMinor': str(exit_value),
                                   'costMinor': str(fees), 'netPnlMinor': str(exit_value - entry - fees)})
                fee_delta = sum(costs[i] - int(f['feeMinor']) for i, f in fills.items())
                final = int(replay['accountSummary']['equityMinor']) - fee_delta
                row = {'symbol': symbol, 'arm': arm, 'completedTradeCount': len(trades),
                       'wins': sum(int(t['netPnlMinor']) > 0 for t in trades),
                       'losses': sum(int(t['netPnlMinor']) < 0 for t in trades),
                       'breakevens': sum(int(t['netPnlMinor']) == 0 for t in trades),
                       'totalCostMinor': str(sum(costs.values())), 'finalEquityMinor': str(final),
                       'openPositionQuantity': replay['accountSummary']['positionQuantity'], 'trades': trades}
                rows.append(row)
                for point in by_symbol[symbol][arm]['equityAndExposureCurve']:
                    delta = sum(costs[i] - int(f['feeMinor']) for i, f in fills.items() if f['timestamp'] <= point['timestamp'])
                    paths[arm][point['timestamp']] = paths[arm].get(point['timestamp'], 0) + int(point['equityMinor']) - delta
        for arm in ARMS:
            selected = [r for r in rows if r['arm'] == arm]
            n = sum(r['completedTradeCount'] for r in selected)
            final = sum(int(r['finalEquityMinor']) for r in selected)
            peak, dd = INITIAL, 0
            for _, equity in sorted(paths[arm].items()):
                peak = max(peak, equity)
                dd = max(dd, (peak - equity) / peak)
            assert list(sorted(paths[arm].items()))[-1][1] == final
            aggregate[arm] = {'completedTradeCount': n, 'wins': sum(r['wins'] for r in selected),
                              'losses': sum(r['losses'] for r in selected), 'breakevens': sum(r['breakevens'] for r in selected),
                              'winRate': sum(r['wins'] for r in selected) / n if n else None,
                              'netPnlMinor': str(final - INITIAL), 'netReturnFraction': (final - INITIAL) / INITIAL,
                              'maximumDrawdownFraction': dd, 'totalCostMinor': str(sum(int(r['totalCostMinor']) for r in selected)),
                              'openPositionQuantities': [r['openPositionQuantity'] for r in selected]}
        assert aggregate['baseline']['completedTradeCount'] == aggregate['candidate']['completedTradeCount'] == 11
        pairs = []
        for symbol in plan['sellTaxBps']:
            b = next(r for r in rows if r['symbol'] == symbol and r['arm'] == 'baseline')['trades']
            c = next(r for r in rows if r['symbol'] == symbol and r['arm'] == 'candidate')['trades']
            assert [(t['openedAtTimestamp'], t['quantity'], t['entryNotionalMinor']) for t in b] == [(t['openedAtTimestamp'], t['quantity'], t['entryNotionalMinor']) for t in c]
            for old, new in zip(b, c):
                diff = int(new['netPnlMinor']) - int(old['netPnlMinor'])
                if diff:
                    pairs.append({'symbol': symbol, 'openedAtTimestamp': old['openedAtTimestamp'], 'differenceMinor': str(diff),
                                  'baselineNetPnlMinor': old['netPnlMinor'], 'candidateNetPnlMinor': new['netPnlMinor']})
        scenarios.append({'id': scenario['id'], 'aggregate': aggregate, 'changedPairs': pairs,
                          'candidateMinusBaselineMinor': str(int(aggregate['candidate']['netPnlMinor']) - int(aggregate['baseline']['netPnlMinor'])),
                          'candidateMinusMarkedBenchmarkMinor': str(int(aggregate['candidate']['netPnlMinor']) - int(aggregate['costMatchedBenchmark']['netPnlMinor'])),
                          'perSymbol': rows})
    original = scenarios[0]['aggregate']
    for arm in ARMS:
        assert original[arm]['netPnlMinor'] == str(int(history['aggregate'][arm]['finalEquityMinor']) - INITIAL)
    c, b = history['aggregate']['candidate'], history['aggregate']['costMatchedBenchmark']
    exposure_ratio = c['calendarWeightedExposureFractionOfInitialCapital'] / b['calendarWeightedExposureFractionOfInitialCapital']
    cpnl, bpnl = int(original['candidate']['netPnlMinor']), int(original['costMatchedBenchmark']['netPnlMinor'])
    exposure = {'candidateCalendarWeightedExposureFraction': c['calendarWeightedExposureFractionOfInitialCapital'],
                'benchmarkCalendarWeightedExposureFraction': b['calendarWeightedExposureFractionOfInitialCapital'],
                'candidateToBenchmarkExposureRatio': exposure_ratio,
                'algebraicBenchmarkPnlAtCandidateCapitalTimeMinor': bpnl * exposure_ratio,
                'algebraicExposureScalePartOfGapMinor': bpnl * (1 - exposure_ratio),
                'remainingAlgebraicGapMinor': bpnl * exposure_ratio - cpnl,
                'classification': 'DESCRIPTIVE_ALGEBRA_NOT_CAUSAL_ATTRIBUTION_OR_IMPLEMENTABLE_RESIZED_RETURN',
                'originalGrossPnlCandidateMinor': str(cpnl + int(c['feesPaidMinor'])),
                'originalGrossPnlBenchmarkMinor': str(bpnl + int(b['feesPaidMinor'])),
                'additionalCandidateFeesMinor': str(int(c['feesPaidMinor']) - int(b['feesPaidMinor']))}
    sources = json.loads((EXPERIMENT / 'official-sources.json').read_text())
    partial_actions = []
    for action in sources['partialCorporateActions']:
        quantities = {}
        for arm in ARMS:
            before = [o for o in observations[action['symbol'], arm]
                      if datetime.fromtimestamp(o['timestamp'] / 1000, timezone.utc).date().isoformat() < action['exDate']]
            quantities[arm] = before[-1]['positionQuantity']
        partial_actions.append({**action, 'savedPositionBeforeExDate': quantities,
                                'grossEntitlementTwdEstimate': {arm: str(Decimal(action['grossTwdPerUnit']) * q) for arm, q in quantities.items()},
                                'appliedToPerformance': False,
                                'classification': 'PARTIAL_POST_HOC_ACTION_DIAGNOSTIC_SETTLEMENT_AND_TAX_UNVERIFIED'})
    assert all(digest(source / name) == value for name, value in hashes.items())
    return {'classification': plan['classification'], 'planSha256': digest(EXPERIMENT / 'plan.json'),
            'sourceResultSha256': digest(result_path), 'sourceReplaySha256': hashes, 'sourceHashesUnchangedAfterRead': True,
            'actualEntrySizes': sizes, 'scenarios': scenarios, 'exposure': exposure,
            'officialSourcesSha256': digest(EXPERIMENT / 'official-sources.json'), 'partialCorporateActions': partial_actions,
            'limitations': ['11 historical trades per arm, not independent prospective observations.',
                            'Fixed fills already include synthetic 100bps slippage per side. No additional slippage applied.',
                            'Costs may alter frozen cost-covered exit decisions. This sensitivity does not rerun or validate those new decisions.',
                            'Whole-TWD ceiling is conservative sensitivity rounding, not actual settlement cents.',
                            'Min1 assumes eligibility not confirmed. Min20 uses public standard schedule, not confirmed user broker.',
                            'Benchmark 4 positions still open: unrealized mark, zero completed trades, winRate null; no hypothetical exit tax charged.',
                            'Corporate actions/dividend taxation/cash settlement and odd-lot execution availability are not fully modeled.',
                            'No lock paths inspected or mutated; original EPERM evidence untouched.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = calculate(args.source_directory)
    with args.output.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'classification': result['classification'], 'scenarios': [
        {'id': s['id'], 'differenceMinor': s['candidateMinusBaselineMinor'], 'candidate': s['aggregate']['candidate']}
        for s in result['scenarios']], 'exposure': result['exposure']}))
