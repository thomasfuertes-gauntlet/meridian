import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OrderBook } from "../components/OrderBook";
import { TradePanel } from "../components/TradePanel";
import { compact, formatContracts, formatRelativePublishTime, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import { flipToNoPerspective } from "../lib/orderbook";
import { IS_LOCAL_RPC, MAG7, MARKET_POLL_MS, type Ticker } from "../lib/constants";
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
  const { data, error, loading } = useMarketUniverse(IS_LOCAL_RPC ? 10_000 : MARKET_POLL_MS);
  const [selectedMarketAddress, setSelectedMarketAddress] = useState<string | null>(null);
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

  const defaultFeatured = markets.find((market) => market.status === "created")
    ?? markets.find((market) => market.status === "frozen")
    ?? markets[0]
    ?? null;
  const featured = markets.find((market) => market.address === selectedMarketAddress)
    ?? defaultFeatured;

  useEffect(() => {
    if (!markets.length) {
      setSelectedMarketAddress(null);
      return;
    }

    if (selectedMarketAddress && markets.some((market) => market.address === selectedMarketAddress)) {
      return;
    }

    setSelectedMarketAddress(defaultFeatured?.address ?? markets[0]?.address ?? null);
  }, [defaultFeatured?.address, markets, selectedMarketAddress]);

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
    <div className="space-y-6">
      <section className="terminal-panel p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <Link to="/markets" className="text-sm text-zinc-400 transition hover:text-white">
              ← Back to markets
            </Link>
            <div className="mt-3 text-[11px] uppercase tracking-[0.28em] text-zinc-500">
              {snapshot?.company ?? ticker}
            </div>
            <h1 className="mt-1 font-display text-4xl text-white">{ticker}</h1>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-zinc-300">
              <span>Oracle spot {snapshot?.latestPrice != null ? money.format(snapshot.latestPrice) : "--"}</span>
              <span>•</span>
              <span>{snapshot?.publishTime ? `Published ${formatRelativePublishTime(snapshot.publishTime)}` : "Oracle unavailable"}</span>
              <span>•</span>
              <span className={statusColor(snapshot?.status ?? "idle")}>
                {snapshot?.status ?? "idle"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.22em] text-zinc-500">
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2">
              Strikes <span className="ml-2 font-mono text-zinc-200">{markets.length}</span>
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2">
              Open interest <span className="ml-2 font-mono text-zinc-200">{compact.format(snapshot?.totalOpenInterest ?? 0)}</span>
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2">
              Best yes mid <span className="ml-2 font-mono text-sky-200">{formatUsdcBaseUnits(snapshot?.topYesMid ?? null)}</span>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <section className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)_360px]">
        <div className="terminal-panel p-3">
          <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-zinc-500">Strikes</div>
          <div className="flex gap-3 overflow-x-auto pb-1 xl:max-h-[520px] xl:flex-col xl:overflow-y-auto xl:overflow-x-hidden">
            {markets.map((market) => {
              const noMid = market.yesMid != null ? 1_000_000 - market.yesMid : null;
              return (
                <button
                  key={market.address}
                  type="button"
                  onClick={() => setSelectedMarketAddress(market.address)}
                  className={`min-w-[176px] shrink-0 rounded-[18px] border px-3 py-3 text-left transition xl:min-w-0 ${
                    featured?.address === market.address
                      ? "border-sky-400/20 bg-sky-400/10"
                      : "border-white/8 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-data text-base text-white">
                      {formatUsdcBaseUnits(market.strikePrice)}
                    </div>
                    <div className={`text-[10px] uppercase tracking-[0.18em] ${statusColor(market.status)}`}>
                      {market.status}
                    </div>
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-zinc-300">
                    <div className="grid grid-cols-[24px_1fr] gap-2">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Yes</div>
                      <div className="font-mono text-white">{formatUsdcBaseUnits(market.yesMid)}</div>
                    </div>
                    <div className="grid grid-cols-[24px_1fr] gap-2">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">No</div>
                      <div className="font-mono text-white">{formatUsdcBaseUnits(noMid)}</div>
                    </div>
                    <div className="grid grid-cols-[88px_1fr] gap-2 pt-1">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Liquidity</div>
                      <div className="text-white">{formatContracts(market.totalDepth)}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
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
              No order book account was available for the selected market.
            </div>
          )}
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
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
              bids={featured.orderBook?.bids ?? []}
              asks={featured.orderBook?.asks ?? []}
            />
          ) : (
            <div className="terminal-panel p-6 text-sm text-zinc-400">
              Entry is unavailable until the selected market has a visible top of book.
            </div>
          )}
        </div>
      </section>

      <section className="terminal-panel p-4">
        <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Selected market</div>
            <h2 className="mt-1 font-data text-2xl text-white">
              {featured ? formatUsdcBaseUnits(featured.strikePrice) : "--"}
            </h2>
          </div>
          {featured && (
            <div className={`text-sm uppercase tracking-[0.24em] ${statusColor(featured.status)}`}>
              {featured.status}
            </div>
          )}
        </div>

        {featured ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-8">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Outcome</div>
              <div className="mt-1 text-sm text-white">{featured.outcome}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Source</div>
              <div className="mt-1 text-sm text-white">{featured.settlementSource ?? "pending"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Yes bid</div>
              <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestBid)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Yes ask</div>
              <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestAsk)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">No bid</div>
              <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestNoBid)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">No ask</div>
              <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.bestNoAsk)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Settlement price</div>
              <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(featured.settlementPrice)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Close time</div>
              <div className="mt-1 text-sm text-white">{formatTimestamp(featured.closeTime)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Book liquidity</div>
              <div className="mt-1 text-sm text-white">{formatContracts(featured.totalDepth)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Pairs minted</div>
              <div className="mt-1 text-sm text-white">{formatContracts(featured.totalPairsMinted)}</div>
            </div>
            <div className="md:col-span-2 xl:col-span-2">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Notes</div>
              <div className="mt-1 text-sm text-zinc-400">
                Live state comes from Anchor account reads, zero-copy order-book parsing, and Pyth price context. The selected strike drives both the entry panel and the depth view above.
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 text-sm text-zinc-400">No current market accounts for this ticker.</div>
        )}
      </section>
    </div>
  );
}
