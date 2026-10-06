import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";

function Strategies({ notify }) {
  const { token } = useAuth();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [strategies, setStrategies] = useState([]);
  const [form, setForm] = useState({ asset: "BTC", amountPerTradeUsd: 50, intervalMinutes: 10 });
  const [expandedId, setExpandedId] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [perfLoading, setPerfLoading] = useState(false);

  const fetchStrategies = useCallback(async () => {
    const res = await fetch("/strategies", { headers: authHeaders });
    const data = await res.json();
    setStrategies(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchStrategies();
    // Refresh periodically so a strategy firing in the background shows up
    // without the user having to do anything.
    const interval = setInterval(fetchStrategies, 15000);
    return () => clearInterval(interval);
  }, [fetchStrategies]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const res = await fetch("/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) {
      setForm({ asset: "BTC", amountPerTradeUsd: 50, intervalMinutes: 10 });
      fetchStrategies();
    }
  };

  const handlePauseResume = async (strategy) => {
    const action = strategy.status === "active" ? "pause" : "resume";
    const res = await fetch(`/strategies/${strategy._id}/${action}`, {
      method: "POST",
      headers: authHeaders,
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) fetchStrategies();
  };

  const handleDelete = async (id) => {
    const res = await fetch(`/strategies/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) {
      fetchStrategies();
      if (expandedId === id) setExpandedId(null);
    }
  };

  const togglePerformance = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      setPerformance(null);
      return;
    }
    setExpandedId(id);
    setPerfLoading(true);
    const res = await fetch(`/strategies/${id}/performance`, { headers: authHeaders });
    const data = await res.json();
    setPerformance(data);
    setPerfLoading(false);
  };

  const formatTime = (t) =>
    t
      ? new Date(t).toLocaleString("en-IN", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";

  return (
    <div>
      <h3>Automated Strategy (DCA)</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
        Automatically invests a fixed dollar amount on a schedule, regardless of price — the same
        market-order engine your manual trades use, just triggered on a timer instead of a click.
      </p>

      <form onSubmit={handleCreate} style={{ marginBottom: 20 }}>
        <label>
          Asset:
          <select value={form.asset} onChange={(e) => setForm({ ...form, asset: e.target.value })}>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
          </select>
        </label>
        <label>
          Amount per trade (USD):
          <input
            type="number"
            min="1"
            step="any"
            value={form.amountPerTradeUsd}
            onChange={(e) => setForm({ ...form, amountPerTradeUsd: Number(e.target.value) })}
          />
        </label>
        <label>
          Every (minutes):
          <input
            type="number"
            min="1"
            step="1"
            value={form.intervalMinutes}
            onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
          />
        </label>
        <button type="submit" className="btn-primary">
          Start Strategy
        </button>
      </form>

      {strategies.length === 0 ? (
        <p className="muted">No strategies yet — create one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Per Trade</th>
              <th>Every</th>
              <th>Status</th>
              <th>Last Ran</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <React.Fragment key={s._id}>
                <tr>
                  <td>{s.asset}</td>
                  <td>${s.amountPerTradeUsd}</td>
                  <td>{s.intervalMinutes} min</td>
                  <td>
                    <span className={`pill ${s.status === "active" ? "pill-buy" : "pill-sell"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td>{formatTime(s.lastRunAt)}</td>
                  <td style={{ display: "flex", gap: 8 }}>
                    <button className="btn-secondary" onClick={() => togglePerformance(s._id)}>
                      {expandedId === s._id ? "Hide" : "Performance"}
                    </button>
                    <button className="btn-secondary" onClick={() => handlePauseResume(s)}>
                      {s.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button className="btn-danger-outline" onClick={() => handleDelete(s._id)}>
                      Delete
                    </button>
                  </td>
                </tr>
                {expandedId === s._id && (
                  <tr>
                    <td colSpan={6}>
                      {perfLoading ? (
                        <p className="muted">Loading performance…</p>
                      ) : performance && performance.tradeCount > 0 ? (
                        <div style={{ padding: "8px 0" }}>
                          <div className="stats-row" style={{ marginBottom: 12 }}>
                            <div className="stat-card">
                              <span className="stat-label">Buys made</span>
                              <span className="stat-value">{performance.tradeCount}</span>
                            </div>
                            <div className="stat-card">
                              <span className="stat-label">Avg. buy price</span>
                              <span className="stat-value">${performance.avgBuyPrice.toFixed(2)}</span>
                            </div>
                          </div>
                          <table>
                            <thead>
                              <tr>
                                <th>Amount Held</th>
                                <th>Invested</th>
                                <th>Current Value</th>
                                <th>P&amp;L</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td>{performance.amount.toFixed(6)}</td>
                                <td>${performance.invested.toFixed(2)}</td>
                                <td>${performance.currentValue.toFixed(2)}</td>
                                <td className={performance.pnl >= 0 ? "text-green" : "text-red"}>
                                  {performance.pnl >= 0 ? "+" : ""}${performance.pnl.toFixed(2)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="muted">
                          No buys yet — it'll execute automatically at the next scheduled interval.
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default Strategies;
