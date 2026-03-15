import { useId, useMemo } from "react";
import type { MarketRecord } from "../lib/market-data";
import { USDC_PER_PAIR } from "../lib/constants";

interface ProbabilityCurveProps {
  markets: MarketRecord[];
  spotPrice: number | null; // dollars (e.g. 142.50)
  selectedStrike: number | null; // base units
  onSelectStrike?: (strikePrice: number) => void;
}

const W = 480;
const H = 160;
const PAD = { top: 20, right: 16, bottom: 28, left: 40 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

/** Catmull-Rom to cubic bezier (same algo as PriceSparkline) */
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

export function ProbabilityCurve({
  markets,
  spotPrice,
  selectedStrike,
  onSelectStrike,
}: ProbabilityCurveProps) {
  const uid = useId();
  const gradId = `prob-grad-${uid}`;

  const { points, xTicks, spotX, linePath, areaPath } = useMemo(() => {
    // Filter to markets with a yes mid, sort by strike
    const active = markets
      .filter((m) => m.yesMid != null && m.status !== "settled")
      .sort((a, b) => a.strikePrice - b.strikePrice);

    if (active.length === 0)
      return { points: [], xTicks: [], spotX: null, linePath: "", areaPath: "" };

    const minStrike = active[0].strikePrice;
    const maxStrike = active[active.length - 1].strikePrice;
    const strikeRange = maxStrike - minStrike || 1;

    const pts: { x: number; y: number; strike: number; prob: number; address: string }[] =
      active.map((m) => {
        const prob = m.yesMid! / USDC_PER_PAIR;
        const x = PAD.left + ((m.strikePrice - minStrike) / strikeRange) * INNER_W;
        const y = PAD.top + INNER_H - prob * INNER_H;
        return { x, y, strike: m.strikePrice, prob, address: m.address };
      });

    const svgPoints: [number, number][] = pts.map((p) => [p.x, p.y]);
    const line = smoothPath(svgPoints);
    const last = svgPoints[svgPoints.length - 1];
    const first = svgPoints[0];
    const area = `${line} L${last[0]},${PAD.top + INNER_H} L${first[0]},${PAD.top + INNER_H} Z`;

    // X-axis tick labels (strike prices in dollars)
    const ticks = pts.map((p) => ({
      x: p.x,
      label: `$${(p.strike / USDC_PER_PAIR).toFixed(0)}`,
    }));

    // Spot price vertical line
    let sX: number | null = null;
    if (spotPrice != null) {
      const spotBase = spotPrice * USDC_PER_PAIR;
      if (spotBase >= minStrike && spotBase <= maxStrike) {
        sX = PAD.left + ((spotBase - minStrike) / strikeRange) * INNER_W;
      }
    }

    return { points: pts, xTicks: ticks, spotX: sX, linePath: line, areaPath: area };
  }, [markets, spotPrice]);

  if (points.length < 2) {
    return (
      <section data-probability-curve>
        <h3>Implied probability</h3>
        <p><mark data-tone="muted">Need 2+ active strikes with book data</mark></p>
      </section>
    );
  }

  return (
    <section data-probability-curve>
      <h3>Implied probability</h3>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", maxHeight: 180, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y-axis labels */}
        {[0, 25, 50, 75, 100].map((pct) => {
          const y = PAD.top + INNER_H - (pct / 100) * INNER_H;
          return (
            <g key={pct}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke="var(--border-subtle)"
                strokeWidth="0.5"
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="var(--muted)"
                fontFamily="var(--mono)"
              >
                {pct}%
              </text>
            </g>
          );
        })}

        {/* X-axis tick labels */}
        {xTicks.map((tick, i) => (
          <text
            key={i}
            x={tick.x}
            y={PAD.top + INNER_H + 16}
            textAnchor="middle"
            fontSize="9"
            fill="var(--muted)"
            fontFamily="var(--mono)"
          >
            {tick.label}
          </text>
        ))}

        {/* Spot price vertical reference */}
        {spotX != null && (
          <g>
            <line
              x1={spotX}
              y1={PAD.top}
              x2={spotX}
              y2={PAD.top + INNER_H}
              stroke="var(--text-dim)"
              strokeWidth="1"
              strokeDasharray="3,3"
            />
            <text
              x={spotX}
              y={PAD.top - 6}
              textAnchor="middle"
              fontSize="9"
              fill="var(--text-dim)"
              fontFamily="var(--mono)"
            >
              spot
            </text>
          </g>
        )}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* Curve line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {points.map((pt) => {
          const isSelected = pt.strike === selectedStrike;
          return (
            <g
              key={pt.address}
              style={{ cursor: onSelectStrike ? "pointer" : undefined }}
              onClick={() => onSelectStrike?.(pt.strike)}
            >
              {/* Hover target (larger invisible circle) */}
              <circle cx={pt.x} cy={pt.y} r="10" fill="transparent" />
              {/* Visible dot */}
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isSelected ? 5 : 3}
                fill={isSelected ? "var(--accent)" : "var(--bg-surface)"}
                stroke={isSelected ? "var(--accent)" : "var(--text-dim)"}
                strokeWidth={isSelected ? 2 : 1.5}
              />
              {/* Label on selected */}
              {isSelected && (
                <text
                  x={pt.x}
                  y={pt.y - 10}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text)"
                  fontFamily="var(--mono)"
                  fontWeight="600"
                >
                  {(pt.prob * 100).toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}
