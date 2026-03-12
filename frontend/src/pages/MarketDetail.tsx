import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OrderBook } from "../components/OrderBook";
import { TradePanel } from "../components/TradePanel";
import { compact, formatContracts, formatRelativePublishTime, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import { formatActivityNotional, formatActivityPrice, useActivityFeed } from "../lib/activity";
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
  const { data: activity } = useActivityFeed(IS_LOCAL_RPC ? 60 : 20);
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
      <div className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-8 text-stone-300">
        Unknown ticker. <Link className="text-amber-200" to="/markets">Return to market grid.</Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="terminal-panel p-3.5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <Link to="/markets" className="text-xs uppercase tracking-[0.2em] text-zinc-500 transition hover:text-white">
              ← Back to markets
            </Link>
            <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
              <h1 className="font-display text-3xl leading-none text-white">{ticker}</h1>
              <div className="pb-0.5 text-[11px] uppercase tracking-[0.28em] text-zinc-500">
                {snapshot?.company ?? ticker}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-sm text-zinc-300">
              <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
                Spot {snapshot?.latestPrice != null ? money.format(snapshot.latestPrice) : "--"}
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
                {snapshot?.publishTime ? `Published ${formatRelativePublishTime(snapshot.publishTime)}` : "Oracle unavailable"}
              </span>
              <span className={statusColor(snapshot?.status ?? "idle")}>
                {snapshot?.status ?? "idle"}
              </span>
            </div>
            {featured && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Selected strike</div>
                  <div className="mt-1 font-data text-lg text-white">{formatUsdcBaseUnits(featured.strikePrice)}</div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Yes bid / ask</div>
                  <div className="mt-1 font-mono text-sm text-white">
                    {formatUsdcBaseUnits(featured.bestBid)} / {formatUsdcBaseUnits(featured.bestAsk)}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">No bid / ask</div>
                  <div className="mt-1 font-mono text-sm text-white">
                    {formatUsdcBaseUnits(featured.bestNoBid)} / {formatUsdcBaseUnits(featured.bestNoAsk)}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Book liquidity</div>
                  <div className="mt-1 text-sm text-white">{formatContracts(featured.totalDepth)}</div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Close time</div>
                  <div className="mt-1 text-sm text-white">{formatTimestamp(featured.closeTime)}</div>
                </div>
              </div>
            )}
          </div>
          <div className="grid gap-2 text-xs uppercase tracking-[0.22em] text-zinc-500 sm:grid-cols-3">
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              Strikes <span className="ml-2 font-mono text-zinc-200">{markets.length}</span>
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              Open interest <span className="ml-2 font-mono text-zinc-200">{compact.format(snapshot?.totalOpenInterest ?? 0)}</span>
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
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

      <section className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[210px_minmax(0,1fr)_360px]">
        <div className="terminal-panel p-3 lg:sticky lg:top-4 lg:self-start">
          <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-zinc-500">Strikes</div>
          <div className="flex gap-3 overflow-x-auto pb-1 lg:max-h-[calc(100vh-13rem)] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
            {markets.map((market) => {
              const noMid = market.yesMid != null ? 1_000_000 - market.yesMid : null;
              return (
                <button
                  key={market.address}
                  type="button"
                  onClick={() => setSelectedMarketAddress(market.address)}
                  className={`min-w-[168px] shrink-0 rounded-[18px] border px-3 py-2.5 text-left transition lg:min-w-0 ${
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
                  <div className="mt-2.5 space-y-2 text-sm text-zinc-300">
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
        <div className="flex flex-col gap-2 border-b border-white/10 pb-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Recent trades</div>
            <h2 className="mt-1 font-display text-2xl text-white">Selected market tape</h2>
          </div>
          <div className="text-sm text-zinc-500">
            {featured ? `${ticker} ${formatUsdcBaseUnits(featured.strikePrice)}` : "No market selected"}
          </div>
        </div>

        {!featured ? (
          <div className="mt-4 text-sm text-zinc-400">No current market accounts for this ticker.</div>
        ) : recentTrades.length === 0 ? (
          <div className="mt-4 rounded-[1.25rem] border border-dashed border-white/10 px-4 py-8 text-sm text-zinc-400">
            No decoded market activity yet for this strike. Current reads are poll-based; the right production upgrade is a read API stream over websocket or SSE so fills and prints land here immediately without browser-side RPC scans.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {recentTrades.map((item) => {
              const tradePrice = formatActivityPrice(item);
              const tradeNotional = formatActivityNotional(item);
              return (
                <div
                  key={`${item.signature}-${item.instructionName}-${item.slot}`}
                  className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/[0.03] px-4 py-3 md:grid-cols-[140px_1fr_120px_120px_140px]"
                >
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{item.label}</div>
                    <div className={`mt-1 text-sm uppercase tracking-[0.18em] ${statusColor(item.success ? "created" : "settled")}`}>
                      {item.success ? "Confirmed" : "Failed"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Time</div>
                    <div className="mt-1 text-sm text-white">{formatTimestamp(item.blockTime)}</div>
                    <div className="text-xs text-zinc-500">{item.user ? `${item.user.slice(0, 4)}...${item.user.slice(-4)}` : "--"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Qty</div>
                    <div className="mt-1 text-sm text-white">{item.amount != null ? formatContracts(item.amount) : "--"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Price</div>
                    <div className="mt-1 font-mono text-sm text-white">{formatUsdcBaseUnits(tradePrice)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Notional</div>
                    <div className="mt-1 text-sm text-white">{tradeNotional != null ? money.format(tradeNotional) : "--"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
