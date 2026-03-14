import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OrderBook } from "../components/OrderBook";
import { TradePanel } from "../components/TradePanel";
import { compact, formatContracts, formatRelativePublishTime, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import { formatActivityNotional, formatActivityPrice, useActivityFeed } from "../lib/activity";
import { flipToNoPerspective } from "../lib/orderbook";
import { MAG7, USDC_PER_PAIR, type Ticker } from "../lib/constants";
import { useMarketData } from "../lib/use-market-data";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";

function statusTone(status: string): "green" | "blue" | "muted" {
  switch (status) {
    case "created": return "green";
    case "frozen": return "blue";
    default: return "muted";
  }
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return "Settlement pending";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `Settles in ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MarketDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const routeTicker = MAG7.find((entry) => entry.ticker === ticker)?.ticker ?? null;
  const { data, error, loading } = useMarketData();
  const { data: activity } = useActivityFeed(20, routeTicker ?? undefined);
  const [selectedMarketAddress, setSelectedMarketAddress] = useState<string | null>(null);
  const [secsToClose, setSecsToClose] = useState<number | null>(null);

  const snapshot = useMemo(
    () => data?.tickerSnapshots.find((entry) => entry.ticker === routeTicker),
    [data, routeTicker]
  );

  const markets = useMemo(
    () => (routeTicker && data ? data.marketsByTicker[routeTicker as Ticker] ?? [] : []),
    [data, routeTicker]
  );

  const featured = useMemo(() => {
    if (!markets.length) return null;
    if (selectedMarketAddress) {
      const selected = markets.find((m) => m.address === selectedMarketAddress);
      if (selected) return selected;
    }
    return markets.find((m) => m.status === "created")
      ?? markets.find((m) => m.status === "frozen")
      ?? markets[0]
      ?? null;
  }, [markets, selectedMarketAddress]);

  // Signal active market to bots so they weight activity toward this strike.
  // On Railway: VITE_SIGNAL_URL points to the bots service signal-server.
  // Locally: Vite dev middleware handles /api/active-ticker.
  const featuredAddress = featured?.address;
  const featuredTicker = featured?.ticker;
  useEffect(() => {
    if (!featuredAddress || !featuredTicker) return;
    const base = import.meta.env.VITE_SIGNAL_URL;
    const url = base
      ? `${base}/active-market?ticker=${featuredTicker}&market=${featuredAddress}`
      : `/api/active-ticker?ticker=${featuredTicker}&market=${featuredAddress}`;
    fetch(url).catch(() => {});
  }, [featuredAddress, featuredTicker]);

  const closeTime = featured?.closeTime ?? null;
  useEffect(() => {
    if (closeTime == null) { setSecsToClose(null); return; }
    const ct = closeTime;
    function tick() {
      setSecsToClose(ct - Math.floor(Date.now() / 1000));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [closeTime]);

  const noBook = featured?.orderBook ? flipToNoPerspective(featured.orderBook) : null;
  const usdcMint = getConfiguredUsdcMint();
  const recentTrades = useMemo(() => {
    if (!featured) return [];
    return activity
      .filter((item) => item.marketAddress === featured.address)
      .slice(0, 8);
  }, [activity, featured]);

  if (!ticker) {
    return null;
  }

  if (!loading && !routeTicker) {
    return (
      <section>
        <p>Unknown ticker. <Link to="/markets">Return to market grid.</Link></p>
      </section>
    );
  }

  return (
    <>
      <section>
        <Link to="/markets">← Back to markets</Link>
        <header>
          <h1>{ticker} <small>{snapshot?.company ?? ticker}</small></h1>
          <dl>
            <dt>Spot</dt>
            <dd>{snapshot?.latestPrice != null ? `$${snapshot.latestPrice.toFixed(2)}` : "--"}</dd>
            <dt>Oracle</dt>
            <dd>{snapshot?.publishTime ? formatRelativePublishTime(snapshot.publishTime) : "unavailable"}</dd>
            <dt>Status</dt>
            <dd><mark data-tone={statusTone(snapshot?.status ?? "idle")}>{snapshot?.status ?? "idle"}</mark></dd>
            <dt>Strikes</dt>
            <dd>{markets.length}</dd>
            <dt>Open interest</dt>
            <dd>{compact.format(snapshot?.totalOpenInterest ?? 0)}</dd>
            <dt>Best yes mid</dt>
            <dd><mark data-tone="blue">{formatUsdcBaseUnits(snapshot?.topYesMid ?? null)}</mark></dd>
          </dl>
          {featured && (
            <dl>
              <dt>Selected strike</dt>
              <dd>{formatUsdcBaseUnits(featured.strikePrice)}</dd>
              <dt>Yes bid / ask</dt>
              <dd>{formatUsdcBaseUnits(featured.bestBid)} / {formatUsdcBaseUnits(featured.bestAsk)}</dd>
              <dt>No bid / ask</dt>
              <dd>{formatUsdcBaseUnits(featured.bestNoBid)} / {formatUsdcBaseUnits(featured.bestNoAsk)}</dd>
              <dt>Book liquidity</dt>
              <dd>{formatContracts(featured.totalDepth)}</dd>
              <dt>Close time</dt>
              <dd>{formatTimestamp(featured.closeTime)}</dd>
              {secsToClose != null && (
                <>
                  <dt>Settlement</dt>
                  <dd><mark data-tone={secsToClose <= 0 ? "muted" : "blue"}>{formatCountdown(secsToClose)}</mark></dd>
                </>
              )}
            </dl>
          )}
        </header>
        {error && <p><mark data-tone="red">{error}</mark></p>}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "210px minmax(0,1fr) 360px", gap: "1rem", background: "none", border: "none", padding: 0 }}>
        <section style={{ position: "sticky", top: "1rem", alignSelf: "start" }}>
          <h3>Strikes</h3>
          <nav style={{ flexDirection: "column", gap: "0.5rem" }}>
            {markets.map((market) => {
              const noMid = market.yesMid != null ? 1_000_000 - market.yesMid : null;
              return (
                <button
                  key={market.address}
                  type="button"
                  data-active={featured?.address === market.address ? "true" : undefined}
                  onClick={() => setSelectedMarketAddress(market.address)}
                  style={{ textAlign: "left", width: "100%" }}
                >
                  <span>{formatUsdcBaseUnits(market.strikePrice)}</span>
                  {" "}
                  <mark data-tone={statusTone(market.status)}>{market.status}</mark>
                  <dl style={{ marginTop: "0.25rem" }}>
                    <dt>Yes</dt>
                    <dd>
                      {formatUsdcBaseUnits(market.yesMid)}
                      {market.yesMid != null && (
                        <> <mark data-tone="blue">{(market.yesMid / USDC_PER_PAIR * 100).toFixed(0)}%</mark></>
                      )}
                    </dd>
                    <dt>No</dt>
                    <dd>{formatUsdcBaseUnits(noMid)}</dd>
                    <dt>Liq</dt>
                    <dd>{formatContracts(market.totalDepth)}</dd>
                  </dl>
                </button>
              );
            })}
          </nav>
        </section>

        <div>
          {featured?.orderBook && noBook ? (
            <OrderBook
              title={`${ticker} depth`}
              bids={featured.orderBook.bids}
              asks={featured.orderBook.asks}
              noBids={noBook.bids}
              noAsks={noBook.asks}
            />
          ) : (
            <section>
              <p><mark data-tone="muted">No order book account was available for the selected market.</mark></p>
            </section>
          )}
        </div>

        <div style={{ position: "sticky", top: "1rem", alignSelf: "start" }}>
          {featured && usdcMint && featured.bestBid != null && featured.bestAsk != null ? (
            <TradePanel
              market={featured.publicKey}
              yesMint={featured.yesMint}
              noMint={featured.noMint}
              usdcMint={usdcMint}
              strikePrice={featured.strikePrice}
              ticker={featured.ticker}
              bestBid={featured.bestBid}
              bestAsk={featured.bestAsk}
            />
          ) : (
            <section>
              <p><mark data-tone="muted">Entry is unavailable until the selected market has a visible top of book.</mark></p>
            </section>
          )}
        </div>
      </section>

      <section>
        <h2>Selected market tape</h2>
        <small>{featured ? `${ticker} ${formatUsdcBaseUnits(featured.strikePrice)}` : "No market selected"}</small>

        {!featured ? (
          <p><mark data-tone="muted">No current market accounts for this ticker.</mark></p>
        ) : recentTrades.length === 0 ? (
          <p><mark data-tone="muted">No decoded market activity yet for this strike.</mark></p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Time</th>
                <th>User</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Notional</th>
              </tr>
            </thead>
            <tbody>
              {recentTrades.map((item) => {
                const tradePrice = formatActivityPrice(item);
                const tradeNotional = formatActivityNotional(item);
                return (
                  <tr key={`${item.signature}-${item.instructionName}-${item.slot}`}>
                    <td>{item.label}</td>
                    <td><mark data-tone={item.success ? "green" : "red"}>{item.success ? "Confirmed" : "Failed"}</mark></td>
                    <td><time>{formatTimestamp(item.blockTime)}</time></td>
                    <td><kbd>{item.user ? `${item.user.slice(0, 4)}...${item.user.slice(-4)}` : "--"}</kbd></td>
                    <td>{item.amount != null ? formatContracts(item.amount) : "--"}</td>
                    <td>{formatUsdcBaseUnits(tradePrice)}</td>
                    <td>{tradeNotional != null ? money.format(tradeNotional) : "--"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
