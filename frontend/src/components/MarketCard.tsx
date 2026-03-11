import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { TickerSnapshot } from "../lib/market-data";
import { usePriceHistory } from "../lib/usePriceHistory";
import { PriceSparkline } from "./PriceSparkline";
import { formatContracts, formatRelativePublishTime, formatUsdcBaseUnits } from "../lib/format";

interface MarketCardProps {
  snapshot: TickerSnapshot;
}

function statusTone(status: TickerSnapshot["status"]): string {
  switch (status) {
    case "created":
      return "text-emerald-300";
    case "frozen":
      return "text-amber-300";
    case "settled":
      return "text-stone-300";
    default:
      return "text-stone-500";
  }
}

export function MarketCard({ snapshot }: MarketCardProps) {
  const navigate = useNavigate();
  // Separate history for CLOB mid-price (moves with bot activity, even outside market hours)
  const { history: clobHistory, push: pushClob } = usePriceHistory(`${snapshot.ticker}-clob`);

  // Feed CLOB mid-price into sparkline history
  useEffect(() => {
    if (snapshot.topYesMid != null) pushClob(snapshot.topYesMid / 1_000_000);
  }, [snapshot.topYesMid, pushClob]);

  return (
    <button
      onClick={() => navigate(`/markets/${snapshot.ticker}`)}
      className="group relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-stone-950/85 p-5 text-left transition hover:-translate-y-0.5 hover:border-amber-200/40"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/60 to-transparent opacity-0 transition group-hover:opacity-100" />
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-stone-500">
            {snapshot.company}
          </div>
          <div className="mt-2 text-3xl font-semibold text-white">
            {snapshot.ticker}
          </div>
        </div>
        <div className={`text-xs uppercase tracking-[0.2em] ${statusTone(snapshot.status)}`}>
          {snapshot.status}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4">
        <div>
          <div className="text-3xl font-semibold text-amber-200">
            {snapshot.latestPrice != null ? `$${snapshot.latestPrice.toFixed(2)}` : "--"}
          </div>
          <div className="mt-1 text-sm text-stone-400">
            {snapshot.publishTime
              ? `Oracle ${formatRelativePublishTime(snapshot.publishTime)}`
              : "Oracle unavailable"}
          </div>
          {snapshot.topYesMid != null && (
            <div className="mt-3 text-sm text-stone-300">
              Yes mid <span className="font-mono text-white">{formatUsdcBaseUnits(snapshot.topYesMid)}</span>
            </div>
          )}
        </div>
        {clobHistory.length >= 2 && (
          <PriceSparkline prices={[...clobHistory]} width={96} height={36} color="#f59e0b" />
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs text-stone-400">
        <div>
          <div className="uppercase tracking-[0.18em] text-stone-600">Strikes</div>
          <div className="mt-1 text-sm text-white">{snapshot.marketCount || "--"}</div>
        </div>
        <div>
          <div className="uppercase tracking-[0.18em] text-stone-600">Open Int.</div>
          <div className="mt-1 text-sm text-white">{formatContracts(snapshot.totalOpenInterest)}</div>
        </div>
        <div>
          <div className="uppercase tracking-[0.18em] text-stone-600">Nearest</div>
          <div className="mt-1 text-sm text-white">
            {snapshot.nearestStrike != null ? formatUsdcBaseUnits(snapshot.nearestStrike) : "--"}
          </div>
        </div>
      </div>
    </button>
  );
}
