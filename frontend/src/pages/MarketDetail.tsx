import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { OrderBook } from "../components/OrderBook";
import { TradePanel } from "../components/TradePanel";
import { compact, formatContracts, formatRelativePublishTime, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import { flipToNoPerspective } from "../lib/orderbook";
import { MAG7, type Ticker } from "../lib/constants";
import { useMarketUniverse } from "../lib/market-data";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";

function statusColor(status: string): string {
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

export function MarketDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const { data, error, loading } = useMarketUniverse(10_000);
  const routeTicker = useMemo(
    () => MAG7.find((entry) => entry.ticker === ticker)?.ticker ?? null,
    [ticker]
  );

  const snapshot = useMemo(
    () => data?.tickerSnapshots.find((entry) => entry.ticker === routeTicker),
    [data, routeTicker]
  );

  const markets = useMemo(
    () => (routeTicker && data ? data.marketsByTicker[routeTicker as Ticker] ?? [] : []),
    [data, routeTicker]
  );

  const featured = markets.find((market) => market.status === "created")
    ?? markets.find((market) => market.status === "frozen")
    ?? markets[0]
    ?? null;

  const noBook = featured?.orderBook ? flipToNoPerspective(featured.orderBook) : null;
  const usdcMint = getConfiguredUsdcMint();

  if (!ticker) {
    return null;
  }

  if (!loading && !routeTicker) {
    return (
      <div className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-8 text-stone-300">
        Unknown ticker. <Link className="text-amber-200" to="/markets">Return to market grid.</Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="terminal-panel p-6">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link to="/markets" className="text-sm text-zinc-400 transition hover:text-white">
              ← Back to markets
            </Link>
            <div className="mt-4 text-[11px] uppercase tracking-[0.28em] text-zinc-500">
              {snapshot?.company ?? ticker}
            </div>
            <h1 className="mt-2 font-display text-5xl text-white">{ticker}</h1>
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-zinc-300">
              <span>Oracle spot {snapshot?.latestPrice != null ? money.format(snapshot.latestPrice) : "--"}</span>
              <span>•</span>
              <span>{snapshot?.publishTime ? `Published ${formatRelativePublishTime(snapshot.publishTime)}` : "Oracle unavailable"}</span>
              <span>•</span>
              <span className={statusColor(snapshot?.status ?? "idle")}>
                {snapshot?.status ?? "idle"}
              </span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Strikes</div>
              <div className="mt-2 font-display text-2xl text-white">{markets.length}</div>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Open interest</div>
              <div className="mt-2 font-display text-2xl text-white">{compact.format(snapshot?.totalOpenInterest ?? 0)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Best yes mid</div>
              <div className="mt-2 font-data text-2xl text-sky-200">{formatUsdcBaseUnits(snapshot?.topYesMid ?? null)}</div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          {markets.map((market) => (
            <div
              key={market.address}
              className={`rounded-[22px] border px-4 py-4 transition ${
                featured?.address === market.address
                  ? "border-sky-400/20 bg-sky-400/10"
                  : "border-white/8 bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-data text-lg text-white">
                  {formatUsdcBaseUnits(market.strikePrice)}
                </div>
                <div className={`text-xs uppercase tracking-[0.2em] ${statusColor(market.status)}`}>
                  {market.status}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-zinc-300">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Yes mid</div>
                  <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(market.yesMid)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Depth</div>
                  <div className="mt-1 text-white">{formatContracts(market.totalDepth)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Close</div>
                  <div className="mt-1 text-white">{formatTimestamp(market.closeTime)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Pairs minted</div>
                  <div className="mt-1 text-white">{formatContracts(market.totalPairsMinted)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="terminal-panel p-5">
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Featured market</div>
            {featured ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <div className="font-data text-3xl text-white">{formatUsdcBaseUnits(featured.strikePrice)}</div>
                    <div className="mt-1 text-sm text-zinc-400">
                      Outcome {featured.outcome} • source {featured.settlementSource ?? "pending"}
                    </div>
                  </div>
                  <div className={`text-sm uppercase tracking-[0.24em] ${statusColor(featured.status)}`}>
                    {featured.status}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm text-zinc-300">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Best yes bid</div>
                    <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestBid)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Best yes ask</div>
                    <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestAsk)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Best no bid</div>
                    <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestNoBid)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Best no ask</div>
                    <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestNoAsk)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Settlement price</div>
                    <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.settlementPrice)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Close time</div>
                    <div className="mt-1 text-white">{formatTimestamp(featured.closeTime)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 text-sm text-zinc-400">No current market accounts for this ticker.</div>
            )}
          </div>

          <div className="terminal-panel p-5">
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Read-path notes</div>
            <div className="mt-4 space-y-3 text-sm leading-7 text-zinc-300">
              <p>This page is derived from Anchor account fetches, zero-copy order-book parsing, and Pyth Hermes price context.</p>
              <p>Trading is now reintroduced through the contract's dedicated trade instructions, rather than reviving the older client-side composition flow.</p>
            </div>
          </div>

          {featured && usdcMint && featured.bestBid != null && featured.bestAsk != null && (
            <TradePanel
              market={featured.publicKey}
              yesMint={featured.yesMint}
              noMint={featured.noMint}
              usdcMint={usdcMint}
              strikePrice={featured.strikePrice}
              ticker={featured.ticker}
              bestBid={featured.bestBid}
              bestAsk={featured.bestAsk}
              bids={featured.orderBook?.bids ?? []}
              asks={featured.orderBook?.asks ?? []}
            />
          )}
        </div>

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
            <div className="terminal-panel p-6 text-sm text-zinc-400">
              No order book account was available for the featured market.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
