import { useId, useMemo } from "react";

interface PriceSparklineProps {
  prices: number[];
  width?: number;
  height?: number;
  /** Accent color for the line/glow */
  color?: string;
}

/** Attempt smooth cubic bezier through points (Catmull-Rom -> Bezier) */
function smoothPath(points: [number, number][]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]}`;
  }

  let d = `M${points[0][0]},${points[0][1]}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }

  return d;
}

export function PriceSparkline({
  prices,
  width = 120,
  height = 40,
  color = "#4ade80",
}: PriceSparklineProps) {
  const uid = useId();
  const gradId = `spark-grad-${uid}`;
  const glowId = `spark-glow-${uid}`;

  const { linePath, areaPath, isUp } = useMemo(() => {
    if (prices.length < 2) return { linePath: "", areaPath: "", isUp: true };

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const padY = height * 0.1;
    const usableH = height - padY * 2;

    const points: [number, number][] = prices.map((p, i) => [
      (i / (prices.length - 1)) * width,
      padY + usableH - ((p - min) / range) * usableH,
    ]);

    const line = smoothPath(points);
    const last = points[points.length - 1];
    const area = `${line} L${last[0]},${height} L${points[0][0]},${height} Z`;
    const up = prices[prices.length - 1] >= prices[0];

    return { linePath: line, areaPath: area, isUp: up };
  }, [prices, width, height]);

  if (prices.length < 2) return null;

  const activeColor = isUp ? color : "#f87171";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      style={{ filter: `drop-shadow(0 0 6px ${activeColor}40)` }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={activeColor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={activeColor} stopOpacity="0" />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Gradient fill under the curve */}
      <path d={areaPath} fill={`url(#${gradId})`}>
        <animate
          attributeName="opacity"
          values="0.6;1;0.6"
          dur="3s"
          repeatCount="indefinite"
        />
      </path>

      {/* Main line with glow */}
      <path
        d={linePath}
        fill="none"
        stroke={activeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${glowId})`}
      />

      {/* Breathing dot on the latest price */}
      <circle
        cx={(prices.length - 1) / (prices.length - 1) * width}
        cy={(() => {
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          const range = max - min || 1;
          const padY = height * 0.1;
          const usableH = height - padY * 2;
          return padY + usableH - ((prices[prices.length - 1] - min) / range) * usableH;
        })()}
        r="2"
        fill={activeColor}
      >
        <animate
          attributeName="r"
          values="2;3.5;2"
          dur="2s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="1;0.5;1"
          dur="2s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}
