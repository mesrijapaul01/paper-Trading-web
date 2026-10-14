
import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
 
const MINUTES_PER_DAY = 1440;
// The server keeps price history for 30 days, so a pattern can't span more.
const MAX_HISTORY_DAYS = 30;
 
// The forms work in DAYS. They're converted to minutes right before sending,
// because the server stores and schedules everything in minutes.
const DEFAULT_DCA = { type: "dca", asset: "BTC", amountPerTradeUsd: 50, intervalDays: 1 };
const DEFAULT_PATTERN = {
  type: "pattern",
  asset: "BTC",
  periodDays: 1,
  downPeriods: 2,
  upPeriods: 2,
  amountPerTradeUsd: 50,
  cooldownDays: 1,
};
 
const daysToMinutes = (days) => Math.max(1, Math.round(Number(days) * MINUTES_PER_DAY));
 
// Show a stored number of minutes in friendly units.
const formatDuration = (minutes) => {
  const m = Number(minutes);
  if (m >= MINUTES_PER_DAY) {
    const d = Math.round((m / MINUTES_PER_DAY) * 100) / 100;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (m >= 60) {
    const h = Math.round((m / 60) * 10) / 10;
    return `${h} hr${h === 1 ? "" : "s"}`;
  }
  return `${m} min`;
};
 
function Strategies({ notify }) {
  const { token } = useAuth();
  const authHeaders = { Authorization: `Bearer ${token}` };
 
  const [strategies, setStrategies] = useState([]);
  const [strategyType, setStrategyType] = useState("dca"); // "dca" | "pattern" - which form is shown
  const [dcaForm, setDcaForm] = useState(DEFAULT_DCA);
  const [patternForm, setPatternForm] = useState(DEFAULT_PATTERN);
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
 
    let body;
    if (strategyType === "dca") {
      body = {
        type: "dca",
        asset: dcaForm.asset,
        amountPerTradeUsd: dcaForm.amountPerTradeUsd,
        intervalMinutes: daysToMinutes(dcaForm.intervalDays),
      };
    } else {
      const neededDays = (patternForm.downPeriods + patternForm.upPeriods + 1) * patternForm.periodDays;
      if (neededDays > MAX_HISTORY_DAYS) {
        notify(
          `\u2717 That pattern needs about ${Math.ceil(neededDays)} days of price history, but only ${MAX_HISTORY_DAYS} days are kept. Use shorter periods or fewer of them.`,
          "error"
        );
        return;
      }
      body = {
        type: "pattern",
        asset: patternForm.asset,
        periodMinutes: daysToMinutes(patternForm.periodDays),
        downPeriods: patternForm.downPeriods,
        upPeriods: patternForm.upPeriods,
        amountPerTradeUsd: patternForm.amountPerTradeUsd,
        cooldownMinutes: daysToMinutes(patternForm.cooldownDays),
      };
    }
 
    const res = await fetch("/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    notify(data.message, res.ok ? "success" : "error");
    if (res.ok) {
      setDcaForm(DEFAULT_DCA);
      setPatternForm(DEFAULT_PATTERN);
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
      : "\u2014";
 
  // One-line human description of what each strategy actually does -
  // shown in the table so you don't have to remember which numbers mean what.
  const describeRule = (s) => {
    if (s.type === "dca") return `$${s.amountPerTradeUsd} every ${formatDuration(s.intervalMinutes)}`;
    return `${s.downPeriods}\u00d7 down then ${s.upPeriods}\u00d7 up (${formatDuration(s.periodMinutes)} periods) \u2192 $${s.amountPerTradeUsd}`;
  };
 
  return (
    <div>
      <h3>Automated Strategies</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
        Both strategy types place real orders through the same matching engine your manual trades
        use &mdash; the only difference is what triggers them.
      </p>
 
      <div className="chart-tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={strategyType === "dca" ? "tab-active" : "tab"}
          onClick={() => setStrategyType("dca")}
        >
          Dollar-Cost Averaging
        </button>
        <button
          type="button"
          className={strategyType === "pattern" ? "tab-active" : "tab"}
          onClick={() => setStrategyType("pattern")}
        >
          Price Pattern
        </button>
      </div>
 
      {strategyType === "dca" ? (
        <form onSubmit={handleCreate} style={{ marginBottom: 20 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Invest a fixed dollar amount on a fixed schedule, regardless of price.
          </p>
          <label>
            Asset:
            <select value={dcaForm.asset} onChange={(e) => setDcaForm({ ...dcaForm, asset: e.target.value })}>
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
              value={dcaForm.amountPerTradeUsd}
              onChange={(e) => setDcaForm({ ...dcaForm, amountPerTradeUsd: Number(e.target.value) })}
            />
          </label>
          <label>
            Every (days):
            <input
              type="number"
              min="0.001"
              step="any"
              value={dcaForm.intervalDays}
              onChange={(e) => setDcaForm({ ...dcaForm, intervalDays: Number(e.target.value) })}
            />
          </label>
          <button type="submit" className="btn-primary">
            Start Strategy
          </button>
        </form>
      ) : (
        <form onSubmit={handleCreate} style={{ marginBottom: 20 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Scans price history for a shape &mdash; N periods trending down, immediately followed by M
            periods trending up &mdash; and buys when found. Every number here is yours to set.
          </p>
          <label>
            Asset:
            <select
              value={patternForm.asset}
              onChange={(e) => setPatternForm({ ...patternForm, asset: e.target.value })}
            >
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="ANY">ANY (scan both, buy whichever matches)</option>
            </select>
          </label>
          <label>
            Period length (days):
            <input
              type="number"
              min="0.001"
              step="any"
              value={patternForm.periodDays}
              onChange={(e) => setPatternForm({ ...patternForm, periodDays: Number(e.target.value) })}
            />
          </label>
          <p className="muted" style={{ fontSize: "0.78rem", marginTop: -6 }}>
            1 = one calendar day. Fractions work too (0.5 = 12 hours). Price history is kept for{" "}
            {MAX_HISTORY_DAYS} days, so (down + up + 1) &times; period length must fit within that.
          </p>
          <label>
            Down periods required:
            <input
              type="number"
              min="1"
              step="1"
              value={patternForm.downPeriods}
              onChange={(e) => setPatternForm({ ...patternForm, downPeriods: Number(e.target.value) })}
            />
          </label>
          <label>
            Up periods required (right after):
            <input
              type="number"
              min="1"
              step="1"
              value={patternForm.upPeriods}
              onChange={(e) => setPatternForm({ ...patternForm, upPeriods: Number(e.target.value) })}
            />
          </label>
          <label>
            Amount per trade (USD):
            <input
              type="number"
              min="1"
              step="any"
              value={patternForm.amountPerTradeUsd}
              onChange={(e) => setPatternForm({ ...patternForm, amountPerTradeUsd: Number(e.target.value) })}
            />
          </label>
          <label>
            Cooldown after a trigger (days):
            <input
              type="number"
              min="0.001"
              step="any"
              value={patternForm.cooldownDays}
              onChange={(e) => setPatternForm({ ...patternForm, cooldownDays: Number(e.target.value) })}
            />
          </label>
          <button type="submit" className="btn-primary">
            Start Strategy
          </button>
        </form>
      )}
 
      {strategies.length === 0 ? (
        <p className="muted">No strategies yet &mdash; create one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Asset</th>
              <th>Rule</th>
              <th>Status</th>
              <th>Last Ran</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <React.Fragment key={s._id}>
                <tr>
                  <td>{s.type === "dca" ? "DCA" : "Pattern"}</td>
                  <td>{s.asset}</td>
                  <td>{describeRule(s)}</td>
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
                        <p className="muted">Loading performance&hellip;</p>
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
                          No buys yet &mdash; it'll execute automatically once its condition is met.
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
