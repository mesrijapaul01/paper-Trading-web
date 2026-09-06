import { useState, useEffect } from "react";
import { io } from "socket.io-client";

// In production, the frontend and backend are served from the same
// origin (Express serves the React build directly — see server.js), so
// the socket should connect to "wherever this page was loaded from,"
// not a hardcoded address. Passing no URL to io() does exactly that.
// Locally, the React dev server (port 3000) and backend (port 5000) are
// different origins, so local dev still needs the explicit localhost:5000
// address (or REACT_APP_SOCKET_URL as an escape hatch for anything else).
const SOCKET_URL =
  process.env.REACT_APP_SOCKET_URL ||
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:5000");

export default function useLiveChartData() {
  const [chartData, setChartData] = useState({
    labels: [],
    datasets: [
      { label: "BTC Price", data: [], borderColor: "blue", fill: false, yAxisID: "y" },
    ],
  });

  useEffect(() => {
    const socket = SOCKET_URL ? io(SOCKET_URL) : io();
    socket.on("chartData", (data) => {
      setChartData(data); // replace with full history each tick
    });
    return () => socket.disconnect();
  }, []);

  return chartData;
}
