# PaperTrade — Full-Stack Paper Trading Platform with a Real Matching Engine

A simulated cryptocurrency trading platform with fake money, but a **real
price-time-priority order-matching engine** underneath — the same core
mechanism a real exchange uses to match buyers and sellers. Built with
React, Node/Express, MongoDB, and Socket.IO.

## 🔴 Live demo

**[http://3.24.113.99:5000](http://3.24.113.99:5000)**

Register a free account (fake money only) or use the demo account to try
placing market and limit orders, and watch the order book / live price
chart update in real time.

## Features

- **Secure authentication** — JWT-based, bcrypt-hashed passwords, every
  protected route derives the user from their token (never from a client-
  supplied ID)
- **A real order-matching engine** — buy and sell orders are matched
  against each other by **price-time priority** (best price first, earliest
  order first among ties), not filled against an external reference price
- **Market orders** — match immediately against whatever's resting in the
  book, at the resting order's price, for as much as liquidity/funds allow
- **Limit orders** — rest in the order book at your target price until
  matched, partially or fully, by an incoming order
- **Real partial fills** — an order can be filled across multiple
  counterparties at different prices, exactly like a real exchange
- **Self-trade prevention** — your own orders never match against each
  other
- **A market-maker bot** — a system participant that posts resting quotes
  near the real CoinGecko price every 15 seconds, so there's always a
  counterparty to trade against during solo testing. It goes through the
  *exact same* matching function as any human order — not a special case
- **Live order book depth** — the bid/ask book is exposed via an API and
  shown on the dashboard, so the matching engine's state is actually
  visible, not a black box
- **Reserved funds/holdings** — can't place multiple pending orders that
  together exceed your actual balance or holdings
- **Wallet** — deposit/withdraw with balance checks (can't overdraw)
- **Portfolio tracking** — live P&L per asset based on the real CoinGecko
  reference price
- **Trade history** and **cumulative P&L over time**
- **Technical indicators** — EMA(5) and RSI(14) computed from your trade
  history
- **Real-time updates** — the dashboard refreshes the moment an order fills
  anywhere in the book, via Socket.IO

## Tech stack

**Frontend:** React, React Router, Chart.js, `technicalindicators`, Socket.IO client
**Backend:** Node.js, Express, MongoDB (native driver), Socket.IO, JWT, bcrypt
**Reference price data:** CoinGecko public API (used to anchor the market
maker's quotes and value your portfolio — not used to fill your trades
directly)

## Project structure
```
server/
  server.js          — API routes, auth, live price polling
  orderBook.js         — the matching engine: order book, matching logic,
                         market-maker quote refresh
  middleware/auth.js    — JWT verification middleware
  .env.example
  package.json
client/
  src/
    App.js              — routing + auth-gated routes
    Login.js / Register.js
    Dashboard.js         — main trading UI
    TradeForm.js          — market/limit order form
    context/AuthContext.js
    components/PriceChart.js       — live price chart
    components/OrderBookDepth.js    — live bid/ask depth display
    hooks/useLiveChartData.js
  public/index.html
  package.json
```

## Running locally

**Backend**
```bash
cd server
cp .env.example .env   # fill in your MongoDB URI and a random JWT_SECRET
npm install
npm run dev
```

**Frontend** (separate terminal)
```bash
cd client
npm install
npm start
```

Backend runs on `:5000`, frontend on `:3000` (proxied to the backend via
`client/package.json`'s `proxy` field).

## How the matching engine works

Every order — market or limit, from a real user or the market-maker bot —
goes through the same function: `matchNewOrder()` in `server/orderBook.js`.

1. It looks at the resting orders on the **opposite side** of the book for
   that asset (buy orders look at asks, sell orders look at bids), sorted
   by **best price first, then earliest placed**.
2. It fills against them one at a time — a market order takes whatever
   price is resting; a limit order only matches at prices at least as good
   as its own limit.
3. Filling stops when: the incoming order is fully filled, the book runs
   out of compatible orders, or the user's available balance/holdings runs
   out (a market order can partially fill if you can't afford the whole
   thing).
4. Any unfilled remainder of a **limit** order is inserted into the
   `orderbook` collection to rest and wait for a future match. Market
   orders don't rest — their unfilled remainder is simply not executed.

Every 15 seconds, the server polls CoinGecko for the real BTC/ETH price and
uses it to refresh the market maker's resting quotes (posted ~0.1% above
and below the real price). Those quotes go through the exact same matching
function, so they can immediately fill a real user's compatible resting
order, or simply sit there as the counterparty for the next market order
that comes in.

## Known limitations

- Only BTC and ETH are supported
- The market maker provides synthetic liquidity — real exchanges have this
  too (official/registered market makers), but it's worth knowing this
  project's book isn't purely peer-to-peer
- No order expiry — limit orders rest indefinitely until filled or cancelled
- Deployed on a single AWS EC2 instance over plain HTTP (no custom domain
  or HTTPS yet) — fine for a portfolio demo, not production-grade
- This is a **simulation with fake money**. It is not a real brokerage or
  exchange and does not handle real funds or comply with financial
  services regulation — see the project discussion for why that's a much
  bigger undertaking than a portfolio project.

## Security note

If you're reading this after cloning: never commit a real `.env` file.
`.env.example` contains placeholders only.
