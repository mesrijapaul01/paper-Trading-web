import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import TradeForm from "./TradeForm";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { EMA, RSI } from "technicalindicators";
import PriceChart from "./components/PriceChart";
import OrderBookDepth from "./components/OrderBookDepth";
import { useAuth } from "./context/AuthContext";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

// Same reasoning as useLiveChartData.js: production serves frontend and
// backend from one origin, so no URL means "connect to wherever this page
// was loaded from." Local dev needs the explicit localhost:5000 address.
const SOCKET_URL =
  process.env.REACT_APP_SOCKET_URL ||
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:5000");

function Dashboard() {
  const { token, email: userEmail, logout } = useAuth();
  const navigate = useNavigate();

  const [balance, setBalance] = useState(0);
  const [amount, setAmount] = useState("");
  const [trades, setTrades] = useState([]);
  const [portfolio, setPortfolio] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null); // { text, type: "success" | "error" }
  const [chartTab, setChartTab] = useState("price"); // "price" | "indicators" | "pnl"
  const [indicatorAsset, setIndicatorAsset] = useState("BTC"); // which asset the Indicators tab shows

  const authHeaders = { Authorization: `Bearer ${token}` };

  const notify = (text, type = "success") => {
    setMessage({ text, type });
    // Auto-dismiss so the banner doesn't linger forever
    setTimeout(() => setMessage((m) => (m && m.text === text ? null : m)), 5000);
  };

  const fetchAll = useCallback(async () => {
    const [walletRes, tradesRes, portfolioRes, ordersRes] = await Promise.all([
      fetch("/wallet", { headers: authHeaders }),
      fetch("/trades", { headers: authHeaders }),
      fetch("/portfolio", { headers: authHeaders }),
      fetch("/orders", { headers: authHeaders }),
    ]);
    const wallet = await walletRes.json();
    const tradesData = await tradesRes.json();
    const portfolioData = await portfolioRes.json();
    const ordersData = await ordersRes.json();
    setBalance(wallet.balance || 0);
    setTrades(tradesData);
    setPortfolio(portfolioData);
    setOrders(ordersData);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Live-refresh when a pending limit order fills on the server, so the
  // dashboard updates without the user having to do anything.
  useEffect(() => {
    const socket = SOCKET_URL ? io(SOCKET_URL) : io();
    socket.on("orderFilled", () => {
      notify("A pending limit order just filled", "success");
      fetchAll();
    });
    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAll]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const updateWallet = async (amt) => {
    if (!amt || amt === 0) return;
    const res = await fetch("/wallet/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ amount: amt }),
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) {
      setAmount("");
      fetchAll();
    }
  };

  const handleSaveTrade = async (trade) => {
    const res = await fetch("/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(trade),
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) fetchAll();
  };

  const handleCancelOrder = async (orderId) => {
    const res = await fetch(`/orders/${orderId}/cancel`, {
      method: "POST",
      headers: authHeaders,
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) fetchAll();
  };

  // --- Client-computed indicators from this user's own trades ---
  // Filtered to one asset at a time — mixing BTC (~$80,000) and ETH
  // (~$2,500) prices on one shared line made the chart look like a crash
  // when it was really just two very different price scales overlapping.
  const chronoTrades = [...trades].reverse();
  const assetTrades = chronoTrades.filter((t) => t.asset === indicatorAsset);
  const prices = assetTrades.map((t) => t.price);

  const emaPeriod = 5;
  const ema =
    prices.length >= emaPeriod
      ? Array(emaPeriod - 1)
          .fill(null)
          .concat(EMA.calculate({ period: emaPeriod, values: prices }))
      : [];

  const rsiPeriod = 14;
  const rsi =
    prices.length >= rsiPeriod + 1
      ? Array(rsiPeriod)
          .fill(null)
          .concat(RSI.calculate({ period: rsiPeriod, values: prices }))
      : [];

  const formatTime = (t) =>
    t
      ? new Date(t).toLocaleString("en-IN", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  const indicatorChartData = {
    labels: assetTrades.map((t) => formatTime(t.createdAt)),
    datasets: [
      { label: `${indicatorAsset} Price`, data: prices, borderColor: "#38bdf8", fill: false },
      { label: `EMA (${emaPeriod})`, data: ema, borderColor: "#4ade80", fill: false },
      { label: `RSI (${rsiPeriod})`, data: rsi, borderColor: "#fb923c", fill: false, yAxisID: "y2" },
    ],
  };

  const indicatorChartOptions = {
    scales: {
      y: { type: "linear", position: "left" },
      y2: { type: "linear", position: "right", min: 0, max: 100 },
    },
  };

  let cumulative = 0;
  const pnlChartData = {
    labels: chronoTrades.map((t) => formatTime(t.createdAt)),
    datasets: [
      {
        label: "Cumulative P&L",
        data: chronoTrades.map((t) => {
          const flow = t.type === "buy" ? -t.amount * t.price : t.amount * t.price;
          cumulative += flow;
          return cumulative;
        }),
        borderColor: "#a78bfa",
        fill: false,
      },
    ],
  };

  if (loading) {
    return (
      <div className="dashboard">
        <p className="loading-text">Loading your dashboard…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h2>Welcome back</h2>
          <p className="muted">{userEmail}</p>
        </div>
        <button className="btn-secondary" onClick={handleLogout}>
          Logout
        </button>
      </header>

      {message && <div className={`banner banner-${message.type}`}>{message.text}</div>}

      <section className="stats-row">
        <div className="stat-card">
          <span className="stat-label">Wallet Balance</span>
          <span className="stat-value">${balance.toFixed(2)}</span>
        </div>
        <div className="stat-card wallet-actions">
          <input
            type="number"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
          />
          <div className="btn-row">
            <button className="btn-primary" onClick={() => updateWallet(Number(amount))}>
              Deposit
            </button>
            <button className="btn-secondary" onClick={() => updateWallet(-Number(amount))}>
              Withdraw
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <TradeForm onSave={handleSaveTrade} />
      </section>

      {orders.length > 0 && (
        <section className="card">
          <h3>Resting Orders (Order Book)</h3>
          <p className="muted" style={{ marginTop: -8, marginBottom: 12 }}>
            These are matched against other participants — including the market maker — in real time.
          </p>
          <table>
            <thead>
              <tr>
                <th>Side</th>
                <th>Asset</th>
                <th>Remaining</th>
                <th>Price</th>
                <th>Status</th>
                <th>Placed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o._id}>
                  <td>
                    <span className={`pill pill-${o.side}`}>{o.side}</span>
                  </td>
                  <td>{o.asset}</td>
                  <td>{o.remaining}</td>
                  <td>${o.price.toLocaleString()}</td>
                  <td>{o.status === "partially_filled" ? "Partially filled" : "Open"}</td>
                  <td>{formatTime(o.createdAt)}</td>
                  <td>
                    <button className="btn-danger-outline" onClick={() => handleCancelOrder(o._id)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <OrderBookDepth />
      </section>

      <section className="card">
        <h3>Trade History</h3>
        {trades.length === 0 ? (
          <p className="muted">No trades yet — place your first order above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Price</th>
                <th>Order Type</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade._id}>
                  <td>
                    <span className={`pill pill-${trade.type}`}>{trade.type}</span>
                  </td>
                  <td>{trade.asset}</td>
                  <td>{trade.amount}</td>
                  <td>${trade.price.toLocaleString()}</td>
                  <td>{trade.orderType}</td>
                  <td>{trade.executed ? "Executed" : "Pending"}</td>
                  <td>{formatTime(trade.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Portfolio</h3>
        {portfolio.length === 0 ? (
          <p className="muted">Nothing held yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Amount</th>
                <th>Invested</th>
                <th>Current Value</th>
                <th>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.map((p) => (
                <tr key={p._id}>
                  <td>{p._id}</td>
                  <td>{p.amount}</td>
                  <td>${p.invested.toFixed(2)}</td>
                  <td>${p.currentValue.toFixed(2)}</td>
                  <td className={p.pnl >= 0 ? "text-green" : "text-red"}>
                    {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="chart-tabs">
          <button
            className={chartTab === "price" ? "tab-active" : "tab"}
            onClick={() => setChartTab("price")}
          >
            Live Price
          </button>
          <button
            className={chartTab === "indicators" ? "tab-active" : "tab"}
            onClick={() => setChartTab("indicators")}
          >
            Indicators
          </button>
          <button className={chartTab === "pnl" ? "tab-active" : "tab"} onClick={() => setChartTab("pnl")}>
            P&amp;L Over Time
          </button>
        </div>

        {chartTab === "indicators" && (
          <div style={{ marginBottom: 12 }}>
            <select value={indicatorAsset} onChange={(e) => setIndicatorAsset(e.target.value)}>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
            </select>
          </div>
        )}

        {chartTab === "price" && <PriceChart />}
        {chartTab === "indicators" &&
          (assetTrades.length > 0 ? (
            <Line data={indicatorChartData} options={indicatorChartOptions} />
          ) : (
            <p className="muted">No {indicatorAsset} trades yet — place one to see indicators.</p>
          ))}
        {chartTab === "pnl" &&
          (chronoTrades.length > 0 ? (
            <Line data={pnlChartData} />
          ) : (
            <p className="muted">Place some trades to see your P&amp;L over time.</p>
          ))}
      </section>
    </div>
  );
}

export default Dashboard;
