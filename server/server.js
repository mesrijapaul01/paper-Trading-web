require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { MongoClient, ObjectId } = require("mongodb");
const axios = require("axios");

const createVerifyToken = require("./middleware/auth");
const { getHoldings, getAvailableBalance, getAvailableHoldings, matchNewOrder, refreshMarketMakerQuotes } = require("./orderBook");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:3000" }));
app.use(bodyParser.json());

const uri = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;

if (!uri) {
  console.error("✗ MONGO_URI is missing from .env — cannot start server.");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("✗ JWT_SECRET is missing from .env — cannot start server.");
  process.exit(1);
}

const client = new MongoClient(uri);
let db;

// Server-side live price cache — populated by the poller further down in
// this file. Declared here (not down near the poller) so every route,
// including /trade and /portfolio, reads from this single shared value
// instead of each firing its own separate CoinGecko request.
let livePrices = {}; // { BTC: 65000, ETH: 3400 }

// Every route below trusts req.userId (from this), never a value from the
// URL/body — that's what fixes the "any user can read anyone's data" bug.
const verifyToken = createVerifyToken(JWT_SECRET);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- Registration ---
app.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "✗ Missing fields" });
    }
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValid) {
      return res.status(400).json({ message: "✗ Invalid email format" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "✗ Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await db.collection("users").findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({ message: "✗ Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.collection("users").insertOne({
      email: normalizedEmail,
      password: hashed,
      balance: 10000,
      createdAt: new Date(),
    });
    res.json({ message: "✓ Registered successfully!" });
  })
);

// --- Login ---
app.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "✗ Missing fields" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await db.collection("users").findOne({ email: normalizedEmail });
    if (!user) return res.status(400).json({ message: "✗ Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "✗ Invalid credentials" });

    const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ message: "✓ Login successful", email: user.email, token });
  })
);

// --- Wallet ---
// No email in the URL anymore — the user is identified from their token.
app.get(
  "/wallet",
  verifyToken,
  asyncHandler(async (req, res) => {
    const user = await db.collection("users").findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ message: "✗ User not found" });
    res.json({ balance: user.balance, email: user.email });
  })
);

app.post(
  "/wallet/update",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (typeof amount !== "number" || Number.isNaN(amount)) {
      return res.status(400).json({ message: "✗ amount must be a number" });
    }

    // A withdrawal (negative amount) that exceeds the current balance was
    // previously allowed with no check, letting balance go negative.
    if (amount < 0) {
      const user = await db.collection("users").findOne({ _id: new ObjectId(req.userId) });
      if (!user) return res.status(404).json({ message: "✗ User not found" });
      if (user.balance + amount < 0) {
        return res.status(400).json({ message: "✗ Insufficient balance to withdraw that amount" });
      }
    }

    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: amount } });
    res.json({ message: "✓ Wallet updated" });
  })
);

// --- Trades ---
// Orders are now matched against a real order book (see orderBook.js)
// instead of filling at an external reference price. Market orders match
// immediately against whatever's resting on the book; limit orders match
// what they can and rest for the remainder.
app.post(
  "/trade",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { asset, type, amount, orderType, price } = req.body;
    if (!asset || !type || !amount) {
      return res.status(400).json({ message: "✗ Missing trade fields" });
    }
    const upperAsset = String(asset).toUpperCase();
    const lowerType = String(type).toLowerCase();
    const lowerOrderType = String(orderType || "market").toLowerCase();

    if (!["buy", "sell"].includes(lowerType)) {
      return res.status(400).json({ message: "✗ type must be buy or sell" });
    }
    if (!["market", "limit"].includes(lowerOrderType)) {
      return res.status(400).json({ message: "✗ orderType must be market or limit" });
    }
    if (!["BTC", "ETH"].includes(upperAsset)) {
      return res.status(400).json({ message: "✗ Only BTC and ETH are supported right now" });
    }

    const user = await db.collection("users").findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ message: "✗ User not found" });

    const orderInput = {
      userId: req.userId,
      email: user.email,
      asset: upperAsset,
      side: lowerType,
      orderType: lowerOrderType,
      amount: Number(amount),
      price: null,
    };

    if (lowerOrderType === "limit") {
      if (!price || price <= 0) {
        return res.status(400).json({ message: "✗ Limit price is required for a limit order" });
      }
      orderInput.price = Number(price);

      // Upfront check against the FULL order size before it's allowed to
      // rest in the book — otherwise a limit order could sit there
      // reserving more than the user actually has.
      if (lowerType === "buy") {
        const available = await getAvailableBalance(db, req.userId);
        if (available < orderInput.amount * orderInput.price) {
          return res.status(400).json({ message: "✗ Insufficient available balance (some is reserved by other pending orders)" });
        }
      } else {
        const available = await getAvailableHoldings(db, req.userId, upperAsset);
        if (available < orderInput.amount) {
          return res.status(400).json({ message: `✗ Insufficient available ${upperAsset} (some is reserved by other pending orders)` });
        }
      }
    } else if (lowerType === "sell") {
      const holdings = await getHoldings(db, req.userId, upperAsset);
      if (holdings <= 0) {
        return res.status(400).json({ message: `✗ You don't hold any ${upperAsset}` });
      }
    }

    const { filled, remaining } = await matchNewOrder(db, io, orderInput);

    if (lowerOrderType === "limit" && remaining > 0) {
      await db.collection("orderbook").insertOne({
        ...orderInput,
        remaining,
        status: filled > 0 ? "partially_filled" : "open",
        createdAt: new Date(),
      });
    }

    if (filled === 0 && lowerOrderType === "market") {
      return res.status(400).json({ message: "✗ No matching liquidity available right now — try again shortly" });
    }

    const message =
      lowerOrderType === "market"
        ? remaining > 0
          ? `✓ Partially filled ${filled} ${upperAsset} — no more liquidity/funds available for the rest`
          : "✓ Market order fully executed"
        : filled > 0
        ? `✓ Limit order partially filled (${filled} ${upperAsset}); ${remaining} resting in the order book`
        : "✓ Limit order placed — resting in the order book";

    res.json({ message, filled, remaining });
  })
);

app.get(
  "/trades",
  verifyToken,
  asyncHandler(async (req, res) => {
    const trades = await db
      .collection("trades")
      .find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(trades);
  })
);

// --- Pending / resting orders ---
app.get(
  "/orders",
  verifyToken,
  asyncHandler(async (req, res) => {
    const orders = await db
      .collection("orderbook")
      .find({ userId: req.userId, status: { $in: ["open", "partially_filled"] } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(orders);
  })
);

app.post(
  "/orders/:id/cancel",
  verifyToken,
  asyncHandler(async (req, res) => {
    const order = await db.collection("orderbook").findOne({ _id: new ObjectId(req.params.id), userId: req.userId });
    if (!order) return res.status(404).json({ message: "✗ Order not found" });
    if (!["open", "partially_filled"].includes(order.status)) {
      return res.status(400).json({ message: `✗ Order already ${order.status}` });
    }
    await db.collection("orderbook").updateOne({ _id: order._id }, { $set: { status: "cancelled", cancelledAt: new Date() } });
    res.json({ message: "✓ Order cancelled" });
  })
);

// Exposes live book depth so the matching engine's state is actually
// visible, not just a black box.
app.get(
  "/orderbook/:asset",
  verifyToken,
  asyncHandler(async (req, res) => {
    const asset = req.params.asset.toUpperCase();
    const [bids, asks] = await Promise.all([
      db
        .collection("orderbook")
        .find({ asset, side: "buy", status: { $in: ["open", "partially_filled"] } })
        .sort({ price: -1, createdAt: 1 })
        .limit(10)
        .toArray(),
      db
        .collection("orderbook")
        .find({ asset, side: "sell", status: { $in: ["open", "partially_filled"] } })
        .sort({ price: 1, createdAt: 1 })
        .limit(10)
        .toArray(),
    ]);
    res.json({
      bids: bids.map((b) => ({ price: b.price, amount: b.remaining })),
      asks: asks.map((a) => ({ price: a.price, amount: a.remaining })),
    });
  })
);


// --- Portfolio ---
async function getPrices() {
  const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
    params: { ids: "bitcoin,ethereum", vs_currencies: "usd" },
  });
  return { BTC: response.data.bitcoin.usd, ETH: response.data.ethereum.usd };
}

app.get(
  "/portfolio",
  verifyToken,
  asyncHandler(async (req, res) => {
    const trades = await db.collection("trades").find({ userId: req.userId }).toArray();
    const portfolio = {};

    trades.forEach((t) => {
      if (!portfolio[t.asset]) {
        portfolio[t.asset] = { amount: 0, invested: 0 };
      }
      if (t.type === "buy") {
        portfolio[t.asset].amount += t.amount;
        portfolio[t.asset].invested += t.amount * t.price;
      } else if (t.type === "sell") {
        portfolio[t.asset].amount -= t.amount;
        portfolio[t.asset].invested -= t.amount * t.price;
      }
    });

    // Read from the shared live-price cache instead of making a fresh
    // CoinGecko call here — this was previously a separate request from
    // the one the poller already makes every 15s, which could hit
    // CoinGecko's rate limit and silently default to $0.
    for (const asset in portfolio) {
      const currentPrice = livePrices[asset] || 0;
      portfolio[asset].currentValue = portfolio[asset].amount * currentPrice;
      portfolio[asset].pnl = portfolio[asset].currentValue - portfolio[asset].invested;
    }

    const result = Object.keys(portfolio).map((asset) => ({
      _id: asset,
      ...portfolio[asset],
    }));

    res.json(result);
  })
);

app.get("/", (req, res) => res.send("Trading API running 🚀"));

// --- Real live price feed + limit order engine ---
// Replaces the old Math.random() simulated feed. Now polls CoinGecko for
// real BTC/ETH prices, and that same price is what market orders execute
// at, what limit orders are checked against, and what the chart shows —
// one consistent source of truth instead of the chart being fake while
// portfolio valuation used real prices.
let priceHistory = { BTC: [], ETH: [] };
let timeHistory = [];

async function refreshLivePrices() {
  try {
    const prices = await getPrices();
    livePrices = prices;

    const now = new Date().toLocaleTimeString();
    priceHistory.BTC.push(prices.BTC);
    priceHistory.ETH.push(prices.ETH);
    timeHistory.push(now);
    if (timeHistory.length > 200) {
      priceHistory.BTC.shift();
      priceHistory.ETH.shift();
      timeHistory.shift();
    }

    io.emit("chartData", {
      labels: [...timeHistory],
      datasets: [
        { label: "BTC Price (live)", data: [...priceHistory.BTC], borderColor: "blue", fill: false, yAxisID: "y" },
      ],
    });

    // Refresh the market maker's resting quotes around the real price —
    // this is what gives the order book liquidity to match against, and
    // may itself trigger fills against real users' resting limit orders.
    if (db) await refreshMarketMakerQuotes(db, io, livePrices);
  } catch (err) {
    console.error("Live price refresh failed, keeping last known prices:", err.message);
  }
}


// Centralized error handler — catches anything asyncHandler forwards
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "✗ Server error" });
});

// Connect to Mongo FIRST, mount routes that need `db`, THEN start listening.
// This fixes the original race condition where requests could arrive before
// `db` was assigned.
async function start() {
  await client.connect();
  db = client.db("tradingApp");
  console.log("✅ Connected to MongoDB Atlas");

  // Prime the live price cache immediately, then poll every 15s. CoinGecko's
  // free tier is fine with this rate; this same price feed drives market
  // order fills, limit order triggers, and the chart.
  await refreshLivePrices();
  setInterval(refreshLivePrices, 15000);

  const port = process.env.PORT || 5000;
  server.listen(port, () => {
    console.log(`🚀 Server running with Socket.IO on port ${port}`);
  });
}

start().catch((err) => {
  console.error("✗ Failed to start server:", err);
  process.exit(1);
});
