const { ObjectId } = require("mongodb");
const { matchNewOrder } = require("./orderBook");

// Automated DCA (Dollar-Cost Averaging) strategy: "invest $X in <asset>
// every N minutes, automatically." This is the standard, well-understood
// form of automated trading strategy — simple to reason about, and it
// produces a genuine, explainable performance story over time (you end up
// with more units when price is low, fewer when price is high).
//
// Execution reuses the exact same matchNewOrder() function real manual
// trades use — a strategy is not a special-cased shortcut, it's just
// another participant placing market orders on a schedule.

async function createStrategy(db, { userId, email, asset, amountPerTradeUsd, intervalMinutes }) {
  const strategy = {
    userId,
    email,
    asset,
    amountPerTradeUsd: Number(amountPerTradeUsd),
    intervalMinutes: Number(intervalMinutes),
    status: "active",
    lastRunAt: null, // null means "never run yet" — fires on the very next check
    createdAt: new Date(),
  };
  const result = await db.collection("strategies").insertOne(strategy);
  return { ...strategy, _id: result.insertedId };
}

async function listStrategies(db, userId) {
  return db.collection("strategies").find({ userId }).sort({ createdAt: -1 }).toArray();
}

async function setStrategyStatus(db, userId, strategyId, status) {
  const result = await db
    .collection("strategies")
    .updateOne({ _id: new ObjectId(strategyId), userId }, { $set: { status } });
  return result.matchedCount > 0;
}

async function deleteStrategy(db, userId, strategyId) {
  const result = await db.collection("strategies").deleteOne({ _id: new ObjectId(strategyId), userId });
  return result.deletedCount > 0;
}

// Called every price-poll cycle (same 15s cadence as the market maker
// refresh). Checks every active strategy across all users and fires any
// that are due.
async function runDueStrategies(db, io, livePrices) {
  const active = await db.collection("strategies").find({ status: "active" }).toArray();
  const now = Date.now();

  for (const strat of active) {
    const due =
      strat.lastRunAt === null || now - new Date(strat.lastRunAt).getTime() >= strat.intervalMinutes * 60 * 1000;
    if (!due) continue;

    const price = livePrices[strat.asset];
    if (!price) continue; // no live price yet this cycle, try again next time

    const user = await db.collection("users").findOne({ _id: new ObjectId(strat.userId) });
    if (!user) continue;

    const amountOfAsset = strat.amountPerTradeUsd / price;

    if (user.balance < strat.amountPerTradeUsd) {
      // Not enough funds this cycle — skip this run but leave the strategy
      // active; it'll try again next interval rather than erroring out.
      await db.collection("strategies").updateOne({ _id: strat._id }, { $set: { lastRunAt: new Date() } });
      continue;
    }

    const order = {
      userId: strat.userId,
      email: strat.email,
      asset: strat.asset,
      side: "buy",
      orderType: "market",
      amount: amountOfAsset,
      strategyId: strat._id.toString(),
    };
    await matchNewOrder(db, io, order);

    await db.collection("strategies").updateOne({ _id: strat._id }, { $set: { lastRunAt: new Date() } });
    io.emit("strategyRan", { strategyId: strat._id.toString(), asset: strat.asset });
  }
}

// Performance for one strategy: pulls only the trades tagged with this
// strategy's id (manual trades are never included), same invested /
// current value / P&L shape as the regular portfolio calculation.
async function getStrategyPerformance(db, userId, strategyId, livePrices) {
  const trades = await db
    .collection("trades")
    .find({ userId, strategyId: strategyId })
    .sort({ createdAt: 1 })
    .toArray();

  let amount = 0;
  let invested = 0;
  for (const t of trades) {
    if (t.type === "buy") {
      amount += t.amount;
      invested += t.amount * t.price;
    } else {
      amount -= t.amount;
      invested -= t.amount * t.price;
    }
  }

  const asset = trades[0]?.asset;
  const currentPrice = asset ? livePrices[asset] || 0 : 0;
  const currentValue = amount * currentPrice;
  const pnl = currentValue - invested;
  const avgBuyPrice = trades.length > 0 ? invested / amount : 0;

  return {
    tradeCount: trades.length,
    amount,
    invested,
    currentValue,
    pnl,
    avgBuyPrice,
    trades,
  };
}

module.exports = {
  createStrategy,
  listStrategies,
  setStrategyStatus,
  deleteStrategy,
  runDueStrategies,
  getStrategyPerformance,
};
