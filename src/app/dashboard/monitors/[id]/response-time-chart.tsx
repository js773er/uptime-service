"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ChartPoint {
  /** Short local time label, e.g. "14:05". */
  time: string;
  responseTimeMs: number | null;
}

export function ResponseTimeChart({ data }: { data: ChartPoint[] }) {
  if (data.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-zinc-500">
        No checks recorded yet.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={40} />
        <YAxis
          tick={{ fontSize: 11 }}
          width={50}
          label={{ value: "ms", position: "insideTopLeft", fontSize: 11 }}
        />
        <Tooltip
          formatter={(value) => [`${value} ms`, "response time"]}
          labelClassName="text-xs"
        />
        <Line
          type="monotone"
          dataKey="responseTimeMs"
          stroke="#18181b"
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
