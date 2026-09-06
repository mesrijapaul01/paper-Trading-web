import React, { useState } from "react";

function TradeForm({ onSave }) {
  const [trade, setTrade] = useState({
    type: "buy", // buy or sell
    asset: "BTC",
    amount: 0,
    price: 0, // only used/sent when orderType === "limit"
    orderType: "market", // market or limit
  });

  const isLimit = trade.orderType === "limit";

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!trade.asset || trade.amount <= 0) {
      alert("✗ Please enter valid trade details");
      return;
    }
    if (isLimit && trade.price <= 0) {
      alert("✗ Enter a limit price");
      return;
    }

    // Market orders don't send a price at all — the server fills them at
    // the live tracked price. Only limit orders carry a target price.
    const payload = {
      type: trade.type,
      asset: trade.asset,
      amount: trade.amount,
      orderType: trade.orderType,
      ...(isLimit ? { price: trade.price } : {}),
    };

    onSave(payload);
    setTrade({ ...trade, amount: 0, price: 0 });
  };

  return (
    <div>
      <h3>New Trade</h3>
      <form onSubmit={handleSubmit}>
        <label>
          Type:
          <select value={trade.type} onChange={(e) => setTrade({ ...trade, type: e.target.value })}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </label>
        <label>
          Asset:
          <select value={trade.asset} onChange={(e) => setTrade({ ...trade, asset: e.target.value })}>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
          </select>
        </label>
        <label>
          Amount:
          <input
            type="number"
            step="any"
            value={trade.amount}
            onChange={(e) => setTrade({ ...trade, amount: Number(e.target.value) })}
          />
        </label>
        <label>
          Order Type:
          <select
            value={trade.orderType}
            onChange={(e) => setTrade({ ...trade, orderType: e.target.value })}
          >
            <option value="market">Market (fills now, at live price)</option>
            <option value="limit">Limit (fills automatically once price is reached)</option>
          </select>
        </label>
        {isLimit && (
          <label>
            Limit Price (USD):
            <input
              type="number"
              step="any"
              value={trade.price}
              onChange={(e) => setTrade({ ...trade, price: Number(e.target.value) })}
            />
          </label>
        )}
        <button type="submit">{isLimit ? "Place Limit Order" : "Execute Market Order"}</button>
      </form>
    </div>
  );
}

export default TradeForm;
