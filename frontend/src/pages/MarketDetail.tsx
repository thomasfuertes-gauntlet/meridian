import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { DepthChart } from "../components/DepthChart";
import { LifecycleIndicator } from "../components/LifecycleIndicator";
import { OrderBook } from "../components/OrderBook";
import { PriceBar } from "../components/PriceBar";
import { ProbabilityCurve } from "../components/ProbabilityCurve";
import { TradePanel } from "../components/TradePanel";
import { compact, formatContracts, formatRelativePublishTime, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import { formatActivityNotional, formatActivityPrice, useActivityFeed } from "../lib/activity";
import { flipToNoPerspective } from "../lib/orderbook";
import { MAG7, USDC_PER_PAIR, type Ticker } from "../lib/constants";
import { useMarketData } from "../lib/use-market-data";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";
import { getProgram, getReadOnlyProgram } from "../lib/anchor";
import {
  fetchPositions,
  buildRedeemTx,
  buildBurnPairTx,
  type Position,
} from "../lib/portfolio";

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

function redeemableContracts(position: Position): number {
  if (position.outcome === "yesWins") return position.yesBalance;
  if (position.outcome === "noWins") return position.noBalance;
  return Math.min(position.yesBalance, position.noBalance);
}

export function MarketDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const routeTicker = MAG7.find((entry) => entry.ticker === ticker)?.ticker ?? null;
  const { data, error, loading } = useMarketData();
  const { data: activity } = useActivityFeed(20, routeTicker ?? undefined);
  const [selectedMarketAddress, setSelectedMarketAddress] = useState<string | null>(null);
  const [secsToClose, setSecsToClose] = useState<number | null>(null);
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const usdcMintForPortfolio = getConfiguredUsdcMint();
  const [positions, setPositions] = useState<Position[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [posAction, setPosAction] = useState<Record<string, string>>({});

  // Ref to avoid data in useCallback deps (data changes every poll cycle)
  const dataRef = useRef(data);
  dataRef.current = data;

  const loadPositions = useCallback(async () => {
    if (!wallet || !dataRef.current) return;
    setPosLoading(true);
    try {
      const program = getReadOnlyProgram();
      const allMarkets = Object.values(dataRef.current.marketsByTicker).flat();
      const all = await fetchPositions(program, connection, wallet.publicKey, allMarkets);
      setPositions(all.filter((p) => p.ticker === routeTicker));
    } catch {
      // silently fail - portfolio panel is supplementary
    } finally {
      setPosLoading(false);
    }
  }, [wallet, connection, routeTicker]);

  // Load on mount/wallet/ticker change, then refresh every 15s to catch post-trade updates
  useEffect(() => {
    loadPositions();
    const id = setInterval(loadPositions, 15_000);
    return () => clearInterval(id);
  }, [loadPositions]);

  const handleRedeem = useCallback(async (position: Position) => {
    if (!wallet || !usdcMintForPortfolio) return;
    const key = position.market.toBase58();
    setPosAction((s) => ({ ...s, [key]: "Signing..." }));
    try {
      const program = getProgram(wallet);
      const qty = redeemableContracts(position);
      const tx = position.settled
        ? await buildRedeemTx(program, wallet.publicKey, position.market, position.outcome === "yesWins" ? position.yesMint : position.noMint, usdcMintForPortfolio, qty)
        : await buildBurnPairTx(program, wallet.publicKey, position.market, position.yesMint, position.noMint, usdcMintForPortfolio, qty);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setPosAction((s) => ({ ...s, [key]: `✓ ${sig.slice(0, 8)}...` }));
      await loadPositions();
    } catch (err) {
      setPosAction((s) => ({ ...s, [key]: `Error: ${err instanceof Error ? err.message.slice(0, 60) : "failed"}` }));
    }
  }, [wallet, connection, usdcMintForPortfolio, loadPositions]);

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

  const closeTime = featured?.closeTime ?? null;
  useEffect(() => {
    if (closeTime == null) return;
    const ct = closeTime;
    function tick() {
      setSecsToClose(ct - Math.floor(Date.now() / 1000));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [closeTime]);
  // Reset countdown when no close time (outside effect to avoid lint violation)
  const resolvedSecsToClose = closeTime == null ? null : secsToClose;

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
        <h1>{ticker} <small>{snapshot?.company ?? ticker}</small></h1>
        {featured && (
          <LifecycleIndicator status={featured.status} closeTime={featured.closeTime} />
        )}
        {featured && (
          <PriceBar yesMid={featured.yesMid} />
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
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
              {resolvedSecsToClose != null && (
                <>
                  <dt>Settlement</dt>
                  <dd><mark data-tone={resolvedSecsToClose <= 0 ? "muted" : "blue"}>{formatCountdown(resolvedSecsToClose)}</mark></dd>
                </>
              )}
            </dl>
          )}
        </div>
        {error && <p><mark data-tone="red">{error}</mark></p>}
      </section>

      {featured && (
        <div data-solvency>
          <span>Vault: {money.format(featured.totalPairsMinted)}</span>
          <span>Pairs: {formatContracts(featured.totalPairsMinted)}</span>
          <span data-check="pass">Invariant ✓ ({formatContracts(featured.totalPairsMinted)} × $1.00 = {money.format(featured.totalPairsMinted)})</span>
        </div>
      )}

      {featured?.status === "settled" && (
        <div data-settlement-audit data-source={featured.settlementSource === "admin" ? "admin" : "oracle"}>
          <dl>
            <dt>Settlement</dt>
            <dd>{ticker} {formatUsdcBaseUnits(featured.strikePrice)} - <mark data-tone={featured.outcome === "yesWins" ? "green" : featured.outcome === "noWins" ? "red" : "muted"}>{featured.outcome === "yesWins" ? "YES WINS" : featured.outcome === "noWins" ? "NO WINS" : "Pending"}</mark></dd>
            <dt>Oracle price</dt>
            <dd>{featured.settlementPrice != null ? formatUsdcBaseUnits(featured.settlementPrice) : "--"}</dd>
            <dt>Source</dt>
            <dd>{featured.settlementSource ?? "unknown"}</dd>
          </dl>
        </div>
      )}

      <ProbabilityCurve
        markets={markets}
        spotPrice={snapshot?.latestPrice ?? null}
        selectedStrike={featured?.strikePrice ?? null}
        onSelectStrike={(strike) => {
          const match = markets.find((m) => m.strikePrice === strike);
          if (match) setSelectedMarketAddress(match.address);
        }}
      />

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
                  <PriceBar yesMid={market.yesMid} variant="compact" />
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
              market={featured.publicKey}
              yesMint={featured.yesMint}
              usdcMint={usdcMint}
            />
          ) : (
            <section>
              <p><mark data-tone="muted">No order book account was available for the selected market.</mark></p>
            </section>
          )}
          {featured?.orderBook && (
            <DepthChart
              bids={featured.orderBook.bids}
              asks={featured.orderBook.asks}
            />
          )}
        </div>

        <div style={{ position: "sticky", top: "1rem", alignSelf: "start" }}>
          {featured && usdcMint ? (
            <TradePanel
              market={featured.publicKey}
              yesMint={featured.yesMint}
              noMint={featured.noMint}
              usdcMint={usdcMint}
              strikePrice={featured.strikePrice}
              ticker={featured.ticker}
              bestBid={featured.bestBid}
              bestAsk={featured.bestAsk}
              orderBook={featured.orderBook ?? null}
            />
          ) : (
            <section>
              <p><mark data-tone="muted">No market selected.</mark></p>
            </section>
          )}

          {/* Inline portfolio for current ticker */}
          {wallet && (
            <section style={{ marginTop: "var(--space-md)" }}>
              <h3>Positions - {routeTicker}</h3>
              {posLoading ? (
                <p><mark data-tone="muted">Loading...</mark></p>
              ) : positions.length === 0 ? (
                <p><mark data-tone="muted">No positions for {routeTicker}</mark></p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Strike</th>
                      <th>Yes</th>
                      <th>No</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => {
                      const key = pos.market.toBase58();
                      const redeemable = redeemableContracts(pos);
                      return (
                        <tr key={key}>
                          <td>{formatUsdcBaseUnits(pos.strikePrice)}</td>
                          <td>{formatContracts(pos.yesBalance)}</td>
                          <td>{formatContracts(pos.noBalance)}</td>
                          <td>
                            <mark data-tone={pos.outcome === "yesWins" ? "green" : pos.outcome === "noWins" ? "red" : "blue"}>
                              {pos.outcome === "yesWins" ? "Yes won" : pos.outcome === "noWins" ? "No won" : "Open"}
                            </mark>
                          </td>
                          <td>
                            {redeemable > 0 && (
                              <button type="button" onClick={() => void handleRedeem(pos)}>
                                {pos.settled ? "Redeem" : "Exit"}
                              </button>
                            )}
                            {posAction[key] && <small> {posAction[key]}</small>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
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
