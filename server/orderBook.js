const { ObjectId } = require("mongodb");

// A system account that posts resting quotes near the real market price so
// solo testing (or a small number of users) still has a counterparty to
// match against. It goes through the exact same matching function as any
// human order — no special-cased matching logic, just a participant that
// happens to always be present.
const MARKET_MAKER_ID = "MARKET_MAKER";
const MARKET_MAKER_EMAIL = "market-maker@system";

async function getHoldings(db, userId, asset) {
  const trades = await db.collection("trades").find({ userId, asset }).toArray();
  return trades.reduce((total, t) => (t.type === "buy" ? total + t.amount : total - t.amount), 0);
}

// Balance minus what's already reserved by this user's other resting buy
// limit orders — prevents placing several orders that together cost more
// than the user actually has.
async function getAvailableBalance(db, userId) {
  const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
  if (!user) return 0;
  const openBuys = await db
    .collection("orderbook")
    .find({ userId, side: "buy", orderType: "limit", status: { $in: ["open", "partially_filled"] } })
    .toArray();
  const reserved = openBuys.reduce((sum, o) => sum + o.remaining * o.price, 0);
  return user.balance - reserved;
}

async function getAvailableHoldings(db, userId, asset) {
  const holdings = await getHoldings(db, userId, asset);
  const openSells = await db
    .collection("orderbook")
    .find({ userId, asset, side: "sell", orderType: "limit", status: { $in: ["open", "partially_filled"] } })
    .toArray();
  const reserved = openSells.reduce((sum, o) => sum + o.remaining, 0);
  return holdings - reserved;
}

// Records the trade and moves balance/holdings for real users. The market
// maker isn't a real user document, so it's skipped on whichever side it's
// on — it's simulated infinite liquidity, not a tracked account.
async function executeFill(db, io, buyOrder, sellOrder, amount, price) {
  if (buyOrder.userId !== MARKET_MAKER_ID) {
    await db.collection("trades").insertOne({
      userId: buyOrder.userId,
      email: buyOrder.email,
      asset: buyOrder.asset,
      type: "buy",
      amount,
      price,
      orderType: buyOrder.orderType,
      executed: true,
      createdAt: new Date(),
    });
    await db.collection("users").updateOne({ _id: new ObjectId(buyOrder.userId) }, { $inc: { balance: -amount * price } });
  }
  if (sellOrder.userId !== MARKET_MAKER_ID) {
    await db.collection("trades").insertOne({
      userId: sellOrder.userId,
      email: sellOrder.email,
      asset: sellOrder.asset,
      type: "sell",
      amount,
      price,
      orderType: sellOrder.orderType,
      executed: true,
      createdAt: new Date(),
    });
    await db.collection("users").updateOne({ _id: new ObjectId(sellOrder.userId) }, { $inc: { balance: amount * price } });
  }
  io.emit("orderFilled", { asset: buyOrder.asset, price, amount });
}

// The matching function itself. Given an incoming order, walks the resting
// opposite-side book in price-time priority and fills against it until the
// order is exhausted, the book runs out of compatible orders, or the
// user's budget (balance for buys, holdings for sells) runs out.
async function matchNewOrder(db, io, order) {
  const counterSide = order.side === "buy" ? "sell" : "buy";
  // Bids (buy side) are best-first at the highest price; asks (sell side)
  // are best-first at the lowest price. Ties broken by earliest createdAt.
  const sortSpec = counterSide === "sell" ? { price: 1, createdAt: 1 } : { price: -1, createdAt: 1 };

  let remaining = order.amount;

  // Compute the user's spending/selling ceiling once up front and decrement
  // it locally as fills happen, rather than re-querying mid-loop.
  let budget = null;
  let holdingsBudget = null;
  if (order.side === "buy" && order.userId !== MARKET_MAKER_ID) {
    budget = await getAvailableBalance(db, order.userId);
  }
  if (order.side === "sell" && order.userId !== MARKET_MAKER_ID) {
    holdingsBudget = await getAvailableHoldings(db, order.userId, order.asset);
  }

  const restingOrders = await db
    .collection("orderbook")
    .find({ asset: order.asset, side: counterSide, status: { $in: ["open", "partially_filled"] } })
    .sort(sortSpec)
    .toArray();

  for (const resting of restingOrders) {
    if (remaining <= 0) break;
    if (resting.userId === order.userId) continue; // self-trade prevention

    if (order.orderType === "limit") {
      const incompatible = order.side === "buy" ? order.price < resting.price : order.price > resting.price;
      // Book is sorted best-price-first, so once we hit an incompatible
      // price nothing further down the book will be compatible either.
      if (incompatible) break;
    }

    let fillAmount = Math.min(remaining, resting.remaining);
    if (budget !== null) {
      fillAmount = Math.min(fillAmount, budget / resting.price);
    }
    if (holdingsBudget !== null) {
      fillAmount = Math.min(fillAmount, holdingsBudget);
    }
    if (fillAmount <= 0) break;

    const fillPrice = resting.price; // resting order's price wins — standard price-time priority
    const buyOrder = order.side === "buy" ? order : resting;
    const sellOrder = order.side === "sell" ? order : resting;
    await executeFill(db, io, buyOrder, sellOrder, fillAmount, fillPrice);

    remaining -= fillAmount;
    if (budget !== null) budget -= fillAmount * fillPrice;
    if (holdingsBudget !== null) holdingsBudget -= fillAmount;

    const newRestingRemaining = resting.remaining - fillAmount;
    await db
      .collection("orderbook")
      .updateOne(
        { _id: resting._id },
        { $set: { remaining: newRestingRemaining, status: newRestingRemaining <= 1e-9 ? "filled" : "partially_filled" } }
      );
    resting.remaining = newRestingRemaining;
  }

  return { filled: order.amount - remaining, remaining };
}

// Refreshes the market maker's resting quotes around the real CoinGecko
// price. Cancels its previous quotes, then posts fresh ones through the
// exact same matchNewOrder path — so if a real user's resting limit order
// is now compatible with the bot's new quote, it fills immediately, same
// as it would against any other participant.
async function refreshMarketMakerQuotes(db, io, livePrices) {
  for (const asset of ["BTC", "ETH"]) {
    const mid = livePrices[asset];
    if (!mid) continue;

    await db
      .collection("orderbook")
      .updateMany(
        { userId: MARKET_MAKER_ID, asset, status: { $in: ["open", "partially_filled"] } },
        { $set: { status: "cancelled" } }
      );

    const spread = mid * 0.001; // 0.1% either side of the real price
    const quotes = [
      { side: "buy", price: +(mid - spread).toFixed(2) },
      { side: "sell", price: +(mid + spread).toFixed(2) },
    ];

    for (const q of quotes) {
      const order = {
        userId: MARKET_MAKER_ID,
        email: MARKET_MAKER_EMAIL,
        asset,
        side: q.side,
        orderType: "limit",
        price: q.price,
        amount: 5,
      };
      const { remaining } = await matchNewOrder(db, io, order);
      if (remaining > 0) {
        await db.collection("orderbook").insertOne({ ...order, remaining, status: "open", createdAt: new Date() });
      }
    }
  }
}

module.exports = {
  MARKET_MAKER_ID,
  getHoldings,
  getAvailableBalance,
  getAvailableHoldings,
  matchNewOrder,
  refreshMarketMakerQuotes,
};
