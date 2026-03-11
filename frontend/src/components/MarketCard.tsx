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
      return "border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
    case "frozen":
      return "border-amber-400/20 bg-amber-400/10 text-amber-200";
    case "settled":
      return "border-white/10 bg-white/[0.03] text-zinc-300";
    default:
      return "border-white/10 bg-white/[0.03] text-zinc-500";
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
      className="terminal-panel market-card-lift group flex h-full flex-col gap-4 p-4 text-left"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="font-display text-2xl text-zinc-50">{snapshot.ticker}</div>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.24em] ${statusTone(snapshot.status)}`}>
              {snapshot.status}
            </span>
          </div>
          <div className="mt-1 text-sm text-zinc-400">{snapshot.company}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Oracle</div>
          <div className="font-data text-sm text-zinc-200">
            {snapshot.publishTime ? formatRelativePublishTime(snapshot.publishTime) : "offline"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-4">
        <div>
          <div className="font-data text-3xl text-zinc-50">
            {snapshot.latestPrice != null ? `$${snapshot.latestPrice.toFixed(2)}` : "--"}
          </div>
          <div className="mt-1 text-sm text-zinc-400">Reference spot</div>
          {snapshot.topYesMid != null && (
            <div className="mt-3 text-sm text-zinc-300">
              Yes mid <span className="font-data text-sky-200">{formatUsdcBaseUnits(snapshot.topYesMid)}</span>
            </div>
          )}
        </div>
        {clobHistory.length >= 2 && (
          <PriceSparkline prices={[...clobHistory]} width={104} height={40} color="#7dd3fc" />
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-300">
          {snapshot.marketCount > 0 ? `${snapshot.marketCount} strikes` : "No markets"}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-300">
          Open interest {formatContracts(snapshot.totalOpenInterest)}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-300">
          {snapshot.nearestStrike != null ? `Nearest ${formatUsdcBaseUnits(snapshot.nearestStrike)}` : "Awaiting strikes"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm text-zinc-400">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Strikes</div>
          <div className="font-data text-zinc-100">{snapshot.marketCount || "--"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Open interest</div>
          <div className="font-data text-zinc-100">{formatContracts(snapshot.totalOpenInterest)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Nearest strike</div>
          <div className="font-data text-zinc-100">
            {snapshot.nearestStrike != null ? formatUsdcBaseUnits(snapshot.nearestStrike) : "--"}
          </div>
        </div>
      </div>
    </button>
  );
}
