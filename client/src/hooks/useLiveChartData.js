import { useState, useEffect } from "react";
import { io } from "socket.io-client";

// Configurable so this doesn't have to be edited by hand for non-local
// deployments — falls back to localhost:5000 for local dev.
const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || "http://localhost:5000";

export default function useLiveChartData() {
  const [chartData, setChartData] = useState({
    labels: [],
    datasets: [
      { label: "BTC Price", data: [], borderColor: "blue", fill: false, yAxisID: "y" },
    ],
  });

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socket.on("chartData", (data) => {
      setChartData(data); // replace with full history each tick
    });
    return () => socket.disconnect();
  }, []);

  return chartData;
}
