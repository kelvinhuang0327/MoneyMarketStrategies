import unittest
from checkSavedExitCosts import fill_cost


class FixedFillCostTest(unittest.TestCase):
    def test_small_odd_lot_standard_minimum_and_stock_sell_tax(self):
        fill = {'executionPriceMinor': '4000', 'quantity': 3, 'side': 'sell', 'feeMinor': '36'}
        self.assertEqual(fill_cost(fill, {'commissionBps': 14.25, 'minCommissionTwd': 20}, 30), 2100)

    def test_etf_tax_differs_and_buy_has_no_sell_tax(self):
        scenario = {'commissionBps': 14.25, 'minCommissionTwd': 20}
        fill = {'executionPriceMinor': '100000', 'quantity': 3, 'side': 'sell', 'feeMinor': '900'}
        self.assertEqual(fill_cost(fill, scenario, 10), 2300)
        self.assertEqual(fill_cost(fill, scenario, 30), 2900)
        self.assertEqual(fill_cost({**fill, 'side': 'buy'}, scenario, 30), 2000)

    def test_commission_above_minimum_uses_undiscounted_rate(self):
        fill = {'executionPriceMinor': '1000000', 'quantity': 3, 'side': 'buy', 'feeMinor': '9000'}
        self.assertEqual(fill_cost(fill, {'commissionBps': 14.25, 'minCommissionTwd': 20}, 30), 4300)

    def test_original_reads_exact_saved_fee_without_tax_or_rounding(self):
        fill = {'executionPriceMinor': '4000', 'quantity': 3, 'side': 'sell', 'feeMinor': '36'}
        self.assertEqual(fill_cost(fill, {'useSavedFees': True}, 30), 36)


if __name__ == '__main__':
    unittest.main()
