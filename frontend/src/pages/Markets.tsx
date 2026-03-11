import { MarketCard } from "../components/MarketCard";
import { compact, formatContracts } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";

export function Markets() {
  const { data, error, loading, stats } = useMarketUniverse();
  const snapshots = data?.tickerSnapshots ?? [];
  const updatedLabel = data?.asOf
    ? new Date(data.asOf).toLocaleTimeString()
    : null;

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-3">
        <div className="terminal-panel p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Tracked markets</div>
          <div className="mt-3 font-display text-4xl text-white">{stats.totalMarkets}</div>
          <div className="mt-2 text-sm text-zinc-400">Latest-date strike markets loaded from chain.</div>
        </div>
        <div className="terminal-panel p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Pairs minted</div>
          <div className="mt-3 font-display text-4xl text-white">{compact.format(stats.totalOpenInterest)}</div>
          <div className="mt-2 text-sm text-zinc-400">{formatContracts(stats.totalOpenInterest)} contracts of open interest.</div>
        </div>
        <div className="terminal-panel p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Indexer state</div>
          <div className="mt-3 font-display text-xl text-white">{loading ? "Syncing" : error ? "Degraded" : "Live"}</div>
          <div className="mt-2 text-sm text-zinc-400">{error ?? "Polling live chain and Hermes every 15 seconds."}</div>
        </div>
      </section>

      <section className="terminal-panel p-6">
        <div className="mb-6 flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Coverage</div>
            <h1 className="mt-2 font-display text-3xl text-white">MAG7 market surface</h1>
          </div>
          <div className="text-sm text-zinc-400">
            {loading ? "Loading..." : updatedLabel ? `Updated ${updatedLabel}` : "Awaiting first snapshot"}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {snapshots.map((snapshot) => (
            <MarketCard key={snapshot.ticker} snapshot={snapshot} />
          ))}
        </div>
      </section>
    </div>
  );
}
