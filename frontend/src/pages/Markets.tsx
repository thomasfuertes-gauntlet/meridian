import { MarketCard } from "../components/MarketCard";
import { compact, formatContracts } from "../lib/format";
import { useMarketData } from "../lib/use-market-data";

export function Markets() {
  const { data, error, loading, stats } = useMarketData();
  const snapshots = data?.tickerSnapshots ?? [];
  const updatedLabel = data?.asOf
    ? new Date(data.asOf).toLocaleTimeString()
    : null;

  return (
    <>
      <section>
        <h1>MAG7 market surface</h1>
        <dl>
          <dt>Tracked markets</dt>
          <dd>{stats.totalMarkets}</dd>
          <dt>Pairs minted</dt>
          <dd>{compact.format(stats.totalOpenInterest)} ({formatContracts(stats.totalOpenInterest)} contracts)</dd>
          <dt>Indexer state</dt>
          <dd>{loading ? "Syncing" : error ? "Degraded" : "Live"}</dd>
          <dt>Updated</dt>
          <dd>{loading ? "Loading..." : updatedLabel ? updatedLabel : "Awaiting first snapshot"}</dd>
        </dl>
        {error && <small>{error}</small>}
      </section>

      <section>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: "1rem" }}>
          {snapshots.map((snapshot) => (
            <MarketCard key={snapshot.ticker} snapshot={snapshot} />
          ))}
        </div>
      </section>
    </>
  );
}
