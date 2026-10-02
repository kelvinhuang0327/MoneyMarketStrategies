import { runDemoFixture } from "./fixture.js";
import { stdout } from "node:process";

function print(line: string): void {
  stdout.write(`${line}\n`);
}

const { engine, outcomes } = runDemoFixture();
print("SIMULATION_ONLY — synthetic prices, fees, slippage, and fills");
print(`strategy_version=${engine.strategyVersion} market_events=${outcomes.length}`);

for (const event of engine.getEvents()) {
  if (event.kind === "decision") {
    print(
      `decision ${event.sourceEventId}: target=${event.targetPositionQuantity ?? "invalid"} status=${event.status} reason=${event.reasonCode}`,
    );
  } else if (event.kind === "order") {
    print(
      `order ${event.clientOrderId}: ${event.status} ${event.side} filled=${event.filledQuantity} remaining=${event.remainingQuantity}${event.reasonCode ? ` reason=${event.reasonCode}` : ""}`,
    );
  } else if (event.kind === "fill") {
    print(
      `fill ${event.fillId}: ${event.side} qty=${event.quantity} price_minor=${event.executionPriceMinor} fee_minor=${event.feeMinor}`,
    );
  }
}

const account = engine.getSnapshot();
print(
  `summary cash_minor=${account.cashMinor} reserved_minor=${account.reservedCashMinor} position=${account.positionQuantity} fees_minor=${account.feesPaidMinor} realized_pnl_minor=${account.realizedPnlMinor} unrealized_pnl_minor=${account.unrealizedPnlMinor} equity_minor=${account.equityMinor}`,
);
