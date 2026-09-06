import { Line } from "react-chartjs-2";
import useLiveChartData from "../hooks/useLiveChartData";

export default function PriceChart() {
  const chartData = useLiveChartData();
  const chartOptions = {
    responsive: true,
    animation: false,
    scales: {
      y: { type: "linear", position: "left" },
    },
  };
  return <Line data={chartData} options={chartOptions} />;
}
