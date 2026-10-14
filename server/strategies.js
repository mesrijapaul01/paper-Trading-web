
const { ObjectId } = require("mongodb");
const { matchNewOrder } = require("./orderBook");
 
// Automated strategies. Both types place ordinary MARKET BUY orders through
// matchNewOrder(), the same function manual trades use.
//
//  - "dca":     buy $X of an asset every N minutes.
//  - "pattern": look at price history in fixed periods; when the last
//               `downPeriods` periods each closed lower than the one before,
//               immediately followed by `upPeriods` periods each closing
//               higher, buy $X. A cooldown stops it re-firing on the same dip.
//
// Collections used: "strategies", "strategyRuns", "priceTicks".
 
const ASSETS = ["BTC", "ETH"];
 
function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}
 
function serialize(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: String(_id), _id: String(_id), ...rest };
}
 
// ---------- price history ----------
 
async function recordPriceTick(db, prices) {
  if (!prices) return;
  const now = new Date();
  const docs = ASSETS.filter((a) => Number(prices[a]) > 0).map((a) => ({
    asset: a,
    price: Number(prices[a]),
    createdAt: now,
  }));
  if (docs.length) await db.collection("priceTicks").insertMany(docs);
}
 
// ---------- create / list / pause / delete ----------
 
async function createStrategy(db, input) {
  const type = input.type === "pattern" ? "pattern" : "dca";
  const now = new Date();
  const strategy = {
    userId: input.userId,
    email: input.email,
    type,
    asset: input.asset,
    amountPerTradeUsd: Number(input.amountPerTradeUsd),
    status: "active",
    createdAt: now,
    lastRunAt: null,
    runCount: 0,
  };
 
  if (type === "dca") {
    strategy.intervalMinutes = Number(input.intervalMinutes);
    strategy.nextRunAt = new Date(now.getTime() + strategy.intervalMinutes * 60000);
  } else {
    strategy.periodMinutes = Number(input.periodMinutes);
    strategy.downPeriods = Number(input.downPeriods);
    strategy.upPeriods = Number(input.upPeriods);
    strategy.cooldownMinutes =
      input.cooldownMinutes !== undefined && input.cooldownMinutes !== "" && Number(input.cooldownMinutes) >= 0
        ? Number(input.cooldownMinutes)
        : strategy.periodMinutes;
    strategy.lastTriggeredAt = null;
  }
 
  const result = await db.collection("strategies").insertOne(strategy);
  return serialize({ _id: result.insertedId, ...strategy });
}
 
async function listStrategies(db, userId) {
  const docs = await db.collection("strategies").find({ userId }).sort({ createdAt: -1 }).toArray();
  return docs.map(serialize);
}
 
async function setStrategyStatus(db, userId, id, status) {
  const _id = toObjectId(id);
  if (!_id) return false;
  const set = { status };
  if (status === "active") {
    const s = await db.collection("strategies").findOne({ _id, userId });
    if (s && s.type === "dca") set.nextRunAt = new Date(Date.now() + s.intervalMinutes * 60000);
  }
  const res = await db.collection("strategies").updateOne({ _id, userId }, { $set: set });
  return res.matchedCount > 0;
}
 
async function deleteStrategy(db, userId, id) {
  const _id = toObjectId(id);
  if (!_id) return false;
  const res = await db.collection("strategies").deleteOne({ _id, userId });
  return res.deletedCount > 0;
}
 
// ---------- pattern detection ----------
 
// ticks: [{price, createdAt}] sorted ascending. Returns true if the most recent
// (down + up) periods match "down...down, up...up".
function detectPattern(ticks, nowMs, periodMinutes, downPeriods, upPeriods) {
  const periodMs = periodMinutes * 60000;
  const total = downPeriods + upPeriods;
  if (!ticks.length) return false;
 
  // Boundary prices p[0..total]: price at the end of each period, p[total] = now.
  const p = [];
  let idx = 0;
  for (let j = 0; j <= total; j++) {
    const boundary = nowMs - (total - j) * periodMs;
    while (idx + 1 < ticks.length && ticks[idx + 1].createdAt.getTime() <= boundary) idx++;
    const t = ticks[idx];
    const tMs = t.createdAt.getTime();
    // Need a tick at/before this boundary and not stale (gap after downtime).
    if (tMs > boundary || boundary - tMs > periodMs) return false;
    p.push(t.price);
  }
 
  for (let j = 0; j < downPeriods; j++) if (!(p[j + 1] < p[j])) return false;
  for (let j = downPeriods; j < total; j++) if (!(p[j + 1] > p[j])) return false;
  return true;
}
 
// ---------- execution ----------
 
async function placeBuy(db, io, strategy, asset, price) {
  const amount = Number((strategy.amountPerTradeUsd / price).toFixed(8));
  if (!(amount > 0)) return null;
 
  const { filled } = await matchNewOrder(db, io, {
    userId: strategy.userId,
    email: strategy.email,
    asset,
    side: "buy",
    orderType: "market",
    amount,
    price: null,
  });
 
  const run = {
    strategyId: String(strategy._id),
    userId: strategy.userId,
    asset,
    side: "buy",
    requestedUnits: amount,
    filledUnits: Number(filled) || 0,
    refPrice: price,
    usdSpent: (Number(filled) || 0) * price,
    createdAt: new Date(),
  };
  await db.collection("strategyRuns").insertOne(run);
  return run;
}
 
async function runDueStrategies(db, io, prices) {
  if (!prices) return;
  const now = new Date();
  const active = await db.collection("strategies").find({ status: "active" }).toArray();
 
  for (const s of active) {
    try {
      if (s.type === "dca") {
        if (!s.nextRunAt || s.nextRunAt > now) continue;
        const price = Number(prices[s.asset]);
        if (!(price > 0)) continue;
        await placeBuy(db, io, s, s.asset, price);
        await db.collection("strategies").updateOne(
          { _id: s._id },
          {
            $set: { lastRunAt: now, nextRunAt: new Date(now.getTime() + s.intervalMinutes * 60000) },
            $inc: { runCount: 1 },
          }
        );
      } else if (s.type === "pattern") {
        const cooldownMs = (s.cooldownMinutes || 0) * 60000;
        if (s.lastTriggeredAt && now - s.lastTriggeredAt < cooldownMs) continue;
 
        const assets = s.asset === "ANY" ? ASSETS : [s.asset];
        const total = s.downPeriods + s.upPeriods;
        const since = new Date(now.getTime() - (total + 1) * s.periodMinutes * 60000);
 
        for (const asset of assets) {
          const price = Number(prices[asset]);
          if (!(price > 0)) continue;
          const ticks = await db
            .collection("priceTicks")
            .find({ asset, createdAt: { $gte: since } })
            .sort({ createdAt: 1 })
            .toArray();
 
          if (detectPattern(ticks, now.getTime(), s.periodMinutes, s.downPeriods, s.upPeriods)) {
            await placeBuy(db, io, s, asset, price);
            await db.collection("strategies").updateOne(
              { _id: s._id },
              { $set: { lastRunAt: now, lastTriggeredAt: now }, $inc: { runCount: 1 } }
            );
            break; // one trigger per strategy per cycle
          }
        }
      }
    } catch (err) {
      console.error(`Strategy ${s._id} failed:`, err.message);
    }
  }
}
 
// ---------- performance ----------
 
async function getStrategyPerformance(db, userId, id, prices) {
  const _id = toObjectId(id);
  const strategy = _id ? await db.collection("strategies").findOne({ _id, userId }) : null;
  if (!strategy) return { strategyId: id, tradeCount: 0, totalInvested: 0, totalUnits: 0, trades: [] };
 
  const runs = await db
    .collection("strategyRuns")
    .find({ strategyId: String(_id), userId })
    .sort({ createdAt: 1 })
    .toArray();
 
  let totalInvested = 0;
  let currentValue = 0;
  const unitsByAsset = {};
  for (const r of runs) {
    totalInvested += r.usdSpent || 0;
    unitsByAsset[r.asset] = (unitsByAsset[r.asset] || 0) + (r.filledUnits || 0);
  }
  for (const [asset, units] of Object.entries(unitsByAsset)) {
    currentValue += units * Number((prices && prices[asset]) || 0);
  }
  const totalUnits = Object.values(unitsByAsset).reduce((a, b) => a + b, 0);
  const pnl = currentValue - totalInvested;
  const avgBuyPrice = totalUnits > 0 ? totalInvested / totalUnits : 0;
 
  // Field names match what client/src/components/Strategies.js reads.
  return {
    strategyId: String(_id),
    type: strategy.type,
    asset: strategy.asset,
    status: strategy.status,
    tradeCount: runs.length,
    amount: totalUnits,
    invested: totalInvested,
    avgBuyPrice,
    currentValue,
    pnl,
    pnlPercent: totalInvested > 0 ? (pnl / totalInvested) * 100 : 0,
    trades: runs.slice(-20).reverse().map(serialize),
  };
}
 
module.exports = {
  recordPriceTick,
  createStrategy,
  listStrategies,
  setStrategyStatus,
  deleteStrategy,
  runDueStrategies,
  getStrategyPerformance,
};
module.exports._detectPattern = detectPattern;
