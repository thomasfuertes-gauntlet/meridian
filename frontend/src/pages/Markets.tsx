import { MarketCard } from "../components/MarketCard";
import { compact, formatContracts } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";

export function Markets() {
  const { data, error, loading, stats } = useMarketUniverse();
  const snapshots = data?.tickerSnapshots ?? [];

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Tracked markets</div>
          <div className="mt-3 text-4xl font-semibold text-white">{stats.totalMarkets}</div>
          <div className="mt-2 text-sm text-stone-400">Latest-date strike markets loaded from chain.</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Pairs minted</div>
          <div className="mt-3 text-4xl font-semibold text-white">{compact.format(stats.totalOpenInterest)}</div>
          <div className="mt-2 text-sm text-stone-400">{formatContracts(stats.totalOpenInterest)} contracts of open interest.</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Indexer state</div>
          <div className="mt-3 text-xl font-semibold text-white">{loading ? "Syncing" : error ? "Degraded" : "Live"}</div>
          <div className="mt-2 text-sm text-stone-400">{error ?? "Polling live chain and Hermes every 15 seconds."}</div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-6">
        <div className="mb-6 flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Coverage</div>
            <h1 className="mt-2 text-3xl font-semibold text-white">MAG7 market surface</h1>
          </div>
          <div className="text-sm text-stone-400">
            {loading ? "Loading..." : `Updated ${new Date(data?.asOf ?? Date.now()).toLocaleTimeString()}`}
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
