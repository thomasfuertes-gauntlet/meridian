import { Link } from "react-router-dom";
import { MarketCard } from "../components/MarketCard";
import { compact, formatContracts } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";

export function Landing() {
  const { data, error, loading, stats } = useMarketUniverse();
  const snapshots = data?.tickerSnapshots ?? [];

  return (
    <>
      <section>
        <h1>Meridian</h1>
        <p>Trade MAG7 close-above markets from a live on-chain book. Each strike is a Yes or No market on whether a stock closes at or above the target price.</p>
        <nav>
          <Link to="/markets">Browse live markets</Link>
          <Link to="/markets/AAPL">Inspect a market detail page</Link>
        </nav>
        <dl>
          <dt>Live tickers</dt>
          <dd>{stats.activeTickers}</dd>
          <dt>Visible order books</dt>
          <dd>{stats.totalMarkets}</dd>
          <dt>Open interest</dt>
          <dd>{compact.format(stats.totalOpenInterest)} ({formatContracts(stats.totalOpenInterest)} pairs)</dd>
        </dl>
      </section>

      <section>
        <h2>Markets</h2>
        <small>{loading ? "Loading live chain + oracle data..." : error ? error : "Polling every 15s"}</small>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: "1rem", marginTop: "1rem" }}>
          {snapshots.map((snapshot) => (
            <MarketCard key={snapshot.ticker} snapshot={snapshot} />
          ))}
        </div>
      </section>
    </>
  );
}
