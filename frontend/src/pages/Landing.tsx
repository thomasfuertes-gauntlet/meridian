import { Link } from "react-router-dom";
import { MarketCard } from "../components/MarketCard";
import { compact, formatContracts } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";

export function Landing() {
  const { data, error, loading, stats } = useMarketUniverse();
  const snapshots = data?.tickerSnapshots ?? [];

  return (
    <div className="space-y-10">
      <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-8">
          <div className="mb-4 text-[11px] uppercase tracking-[0.3em] text-amber-200/80">
            On-chain binary equity markets
          </div>
          <h1 className="max-w-3xl text-5xl font-semibold leading-tight text-white sm:text-6xl">
            Rebuilding the terminal around live state, not prototype glue.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-300">
            Meridian prices MAG7 close-above strikes directly from Solana accounts,
            the built-in order book, and Pyth price context. This first pass is intentionally
            read-first so the new frontend foundation matches the Rust program before trade flows return.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/markets"
              className="rounded-full bg-amber-200 px-5 py-3 text-sm font-medium text-stone-950 transition hover:bg-amber-100"
            >
              Browse live markets
            </Link>
            <Link
              to="/markets/AAPL"
              className="rounded-full border border-white/10 px-5 py-3 text-sm text-stone-200 transition hover:border-amber-200/40 hover:text-white"
            >
              Inspect a market detail page
            </Link>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Live tickers</div>
            <div className="mt-3 text-4xl font-semibold text-white">{stats.activeTickers}</div>
            <div className="mt-2 text-sm text-stone-400">Tickers with fresh markets on the latest trading date.</div>
          </div>
          <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Visible order books</div>
            <div className="mt-3 text-4xl font-semibold text-white">{stats.totalMarkets}</div>
            <div className="mt-2 text-sm text-stone-400">Latest-strike market accounts indexed from chain.</div>
          </div>
          <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Open interest</div>
            <div className="mt-3 text-4xl font-semibold text-white">{compact.format(stats.totalOpenInterest)}</div>
            <div className="mt-2 text-sm text-stone-400">{formatContracts(stats.totalOpenInterest)} pairs minted across current markets.</div>
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-6">
        <div className="flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Market grid</div>
            <h2 className="mt-2 text-2xl font-semibold text-white">Current read model</h2>
          </div>
          <div className="text-sm text-stone-400">
            {loading ? "Loading live chain + oracle data..." : error ? error : "Polling every 15s"}
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {snapshots.map((snapshot) => (
            <MarketCard key={snapshot.ticker} snapshot={snapshot} />
          ))}
        </div>
      </section>
    </div>
  );
}
