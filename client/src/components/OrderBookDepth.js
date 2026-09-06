import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";

// Shows the live bid/ask depth for an asset — tangible proof the matching
// engine is real, not just a black box behind a "Buy"/"Sell" button.
function OrderBookDepth() {
  const { token } = useAuth();
  const [asset, setAsset] = useState("BTC");
  const [book, setBook] = useState({ bids: [], asks: [] });

  const fetchBook = useCallback(async () => {
    try {
      const res = await fetch(`/orderbook/${asset}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setBook(data);
    } catch (err) {
      // Non-critical widget — fail quietly and just leave the last known book
    }
  }, [asset, token]);

  useEffect(() => {
    fetchBook();
    const interval = setInterval(fetchBook, 5000);
    return () => clearInterval(interval);
  }, [fetchBook]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Order Book</h3>
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          <option value="BTC">BTC</option>
          <option value="ETH">ETH</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <p className="muted" style={{ marginBottom: 6 }}>
            Bids (buyers)
          </p>
          <table>
            <thead>
              <tr>
                <th>Price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {book.bids.length === 0 ? (
                <tr>
                  <td colSpan={2} className="muted">
                    No bids
                  </td>
                </tr>
              ) : (
                book.bids.map((b, i) => (
                  <tr key={i}>
                    <td className="text-green">${b.price.toLocaleString()}</td>
                    <td>{b.amount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div>
          <p className="muted" style={{ marginBottom: 6 }}>
            Asks (sellers)
          </p>
          <table>
            <thead>
              <tr>
                <th>Price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {book.asks.length === 0 ? (
                <tr>
                  <td colSpan={2} className="muted">
                    No asks
                  </td>
                </tr>
              ) : (
                book.asks.map((a, i) => (
                  <tr key={i}>
                    <td className="text-red">${a.price.toLocaleString()}</td>
                    <td>{a.amount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default OrderBookDepth;
