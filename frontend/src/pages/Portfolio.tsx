import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getProgram, getReadOnlyProgram } from "../lib/anchor";
import { DeskSelector } from "../components/DeskSelector";
import { MAG7, type Ticker } from "../lib/constants";
import { money, formatContracts, formatUsdcBaseUnits } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";
import { getDeskWallets } from "../lib/dev-wallets";
import {
  buildBurnPairTx,
  buildRedeemTx,
  fetchPositionPerformance,
  fetchPositions,
  type PositionPerformance,
  type Position,
} from "../lib/portfolio";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";

function outcomeTone(outcome: Position["outcome"]): string {
  switch (outcome) {
    case "yesWins":
      return "text-emerald-300";
    case "noWins":
      return "text-rose-300";
    default:
      return "text-amber-300";
  }
}

function markValue(position: Position, yesMid: number | null): number {
  if (position.outcome === "yesWins") return position.yesBalance;
  if (position.outcome === "noWins") return position.noBalance;
  if (yesMid == null) return 0;
  const yesValue = position.yesBalance * (yesMid / 1_000_000);
  const noValue = position.noBalance * ((1_000_000 - yesMid) / 1_000_000);
  return yesValue + noValue;
}

function outcomeLabel(outcome: Position["outcome"]): string {
  switch (outcome) {
    case "yesWins":
      return "Yes won";
    case "noWins":
      return "No won";
    default:
      return "Open";
  }
}

function currentYesPrice(position: Position, yesMid: number | null): number | null {
  if (position.outcome === "yesWins") return 1_000_000;
  if (position.outcome === "noWins") return 0;
  return yesMid;
}

function currentNoPrice(position: Position, yesMid: number | null): number | null {
  const yesPrice = currentYesPrice(position, yesMid);
  return yesPrice == null ? null : 1_000_000 - yesPrice;
}

function redeemableContracts(position: Position): number {
  if (position.outcome === "yesWins") return position.yesBalance;
  if (position.outcome === "noWins") return position.noBalance;
  return Math.min(position.yesBalance, position.noBalance);
}

function pnlTone(value: number | null): string {
  if (value == null) return "text-stone-400";
  if (value > 0) return "text-emerald-300";
  if (value < 0) return "text-rose-300";
  return "text-stone-200";
}

function hasPartialHistory(positions: Array<{ performance?: PositionPerformance }>): boolean {
  return positions.some((position) => position.performance?.partialHistory);
}

export function Portfolio() {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const { data } = useMarketUniverse(20_000);
  const desks = useMemo(() => getDeskWallets(wallet?.publicKey), [wallet]);
  const [selectedDeskId, setSelectedDeskId] = useState<string>("");
  const [positions, setPositions] = useState<Position[]>([]);
  const [performance, setPerformance] = useState<Map<string, PositionPerformance>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, string>>({});
  const usdcMint = getConfiguredUsdcMint();
  const selectedDesk = useMemo(
    () => desks.find((entry) => entry.id === selectedDeskId) ?? desks[0] ?? null,
    [desks, selectedDeskId]
  );
  const canMutateSelectedDesk =
    !!wallet && !!selectedDesk && wallet.publicKey.equals(selectedDesk.publicKey);

  useEffect(() => {
    if (!selectedDeskId && desks[0]) {
      setSelectedDeskId(desks[0].id);
      return;
    }
    if (selectedDeskId && !desks.some((entry) => entry.id === selectedDeskId) && desks[0]) {
      setSelectedDeskId(desks[0].id);
    }
  }, [desks, selectedDeskId]);

  const loadPositions = useCallback(async () => {
    if (!selectedDesk) {
      setPositions([]);
      setPerformance(new Map());
      return;
    }

    setLoading(true);
    try {
      const program = getReadOnlyProgram();
      const next = await fetchPositions(program, connection, selectedDesk.publicKey);
      setPositions(next);
      if (usdcMint) {
        const nextPerformance = await fetchPositionPerformance(connection, selectedDesk.publicKey, next, usdcMint);
        setPerformance(nextPerformance);
      } else {
        setPerformance(new Map());
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load positions");
    } finally {
      setLoading(false);
    }
  }, [connection, selectedDesk, usdcMint]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const enriched = useMemo(() => {
    return positions.map((position) => {
      const ticker = MAG7.find((entry) => entry.ticker === position.ticker)?.ticker ?? null;
      const market =
        ticker && data
          ? data.marketsByTicker[ticker as Ticker]?.find(
          (item) => item.address === position.market.toBase58()
            )
          : null;
      const mid = market?.yesMid ?? null;
      const yesPrice = currentYesPrice(position, mid);
      const noPrice = currentNoPrice(position, mid);
      const redeemable = redeemableContracts(position);
      const perf = performance.get(position.market.toBase58());
      const currentValue = markValue(position, mid);
      const costBasis = perf?.costBasis ?? null;
      return {
        ...position,
        marketView: market,
        performance: perf,
        markValue: currentValue,
        yesPrice,
        noPrice,
        redeemable,
        redeemableValue: redeemable,
        costBasis,
        unrealizedPnl:
          costBasis != null
            ? currentValue - costBasis
            : null,
      };
    });
  }, [data, performance, positions]);

  const totals = useMemo(() => {
    return enriched.reduce(
      (acc, position) => {
        acc.yes += position.yesBalance;
        acc.no += position.noBalance;
        acc.markValue += position.markValue;
        acc.redeemable += position.redeemable;
        acc.costBasis += position.costBasis ?? 0;
        acc.unrealizedPnl += position.unrealizedPnl ?? 0;
        acc.realizedPnl += position.performance?.realizedPnl ?? 0;
        return acc;
      },
      { yes: 0, no: 0, markValue: 0, redeemable: 0, costBasis: 0, unrealizedPnl: 0, realizedPnl: 0 }
    );
  }, [enriched]);

  const partialHistoryVisible = useMemo(() => hasPartialHistory(enriched), [enriched]);

  const handleRedeem = useCallback(async (position: Position) => {
    if (!wallet || !selectedDesk || !canMutateSelectedDesk || !usdcMint) return;

    const actionKey = position.market.toBase58();
    setActionState((current) => ({ ...current, [actionKey]: "Building transaction..." }));

    try {
      const program = getProgram(wallet);
      const tx = position.settled
        ? await buildRedeemTx(
            program,
            selectedDesk.publicKey,
            position.market,
            position.outcome === "yesWins" ? position.yesMint : position.noMint,
            usdcMint,
            redeemableContracts(position)
          )
        : await buildBurnPairTx(
            program,
            selectedDesk.publicKey,
            position.market,
            position.yesMint,
            position.noMint,
            usdcMint,
            redeemableContracts(position)
          );

      setActionState((current) => ({ ...current, [actionKey]: "Awaiting signature..." }));

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = selectedDesk.publicKey;

      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      setActionState((current) => ({
        ...current,
        [actionKey]: `Confirmed: ${signature.slice(0, 8)}...`,
      }));
      await loadPositions();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transaction failed";
      setActionState((current) => ({ ...current, [actionKey]: `Error: ${message}` }));
    }
  }, [canMutateSelectedDesk, connection, loadPositions, selectedDesk, usdcMint, wallet]);

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Yes tokens</div>
          <div className="mt-3 text-4xl font-semibold text-white">{formatContracts(totals.yes)}</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">No tokens</div>
          <div className="mt-3 text-4xl font-semibold text-white">{formatContracts(totals.no)}</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Mark value</div>
          <div className="mt-3 text-4xl font-semibold text-white">{money.format(totals.markValue)}</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Cost basis</div>
          <div className="mt-3 text-4xl font-semibold text-white">{money.format(totals.costBasis)}</div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Unrealized P&L</div>
          <div className={`mt-3 text-4xl font-semibold ${pnlTone(totals.unrealizedPnl)}`}>
            {money.format(totals.unrealizedPnl)}
          </div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Realized P&L</div>
          <div className={`mt-3 text-4xl font-semibold ${pnlTone(totals.realizedPnl)}`}>
            {money.format(totals.realizedPnl)}
          </div>
        </div>
        <div className="rounded-[1.75rem] border border-white/10 bg-stone-950/85 p-5 md:col-span-3">
          <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Redeemable now</div>
          <div className="mt-3 text-4xl font-semibold text-white">{money.format(totals.redeemable)}</div>
          <div className="mt-2 text-sm text-stone-400">
            Includes settled winners and pre-settlement complete sets.
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-6">
        <div className="mb-6 flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Wallet holdings</div>
            <h1 className="mt-2 text-3xl font-semibold text-white">Live positions and exits</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <DeskSelector
              desks={desks}
              selectedDeskId={selectedDesk?.id ?? desks[0]?.id ?? ""}
              onChange={setSelectedDeskId}
              label="Wallet"
            />
            <button
              onClick={loadPositions}
              disabled={loading}
              className="rounded-full border border-white/10 px-4 py-2 text-sm text-stone-200 transition hover:border-amber-200/40 hover:text-white disabled:opacity-60"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mb-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
          {selectedDesk ? (
            canMutateSelectedDesk
              ? `Viewing ${selectedDesk.label}. Redeem and complete-set exit actions are enabled for this connected wallet.`
              : `Viewing ${selectedDesk.label} in read-only mode. Connect that wallet to sign exits from this desk.`
          ) : (
            "No wallet selected."
          )}
        </div>

        {partialHistoryVisible && (
          <div className="mb-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
            Cost basis and unrealized P&amp;L are hidden for positions whose current inventory is older than the fetched transaction window or came from non-canonical flows.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        {enriched.length === 0 ? (
          <div className="rounded-[1.5rem] border border-dashed border-white/10 px-6 py-10 text-center text-stone-400">
            {loading ? "Loading wallet positions..." : "No positions found for this wallet."}
          </div>
        ) : (
          <div className="space-y-4">
            {enriched.map((position) => (
              <div
                key={position.market.toBase58()}
                className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">
                      {position.ticker}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <h2 className="text-2xl font-semibold text-white">
                        {formatUsdcBaseUnits(position.strikePrice)}
                      </h2>
                      <span className={`text-xs uppercase tracking-[0.2em] ${outcomeTone(position.outcome)}`}>
                        {outcomeLabel(position.outcome)}
                      </span>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-5">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Yes</div>
                      <div className="mt-1 text-lg text-white">{formatContracts(position.yesBalance)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">No</div>
                      <div className="mt-1 text-lg text-white">{formatContracts(position.noBalance)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Mark</div>
                      <div className="mt-1 text-lg text-white">{money.format(position.markValue)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Redeemable</div>
                      <div className="mt-1 text-lg text-white">{money.format(position.redeemableValue)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">U. P&L</div>
                      <div className={`mt-1 text-lg ${pnlTone(position.unrealizedPnl)}`}>
                        {position.unrealizedPnl != null ? money.format(position.unrealizedPnl) : "--"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 text-sm text-stone-300 sm:grid-cols-2 lg:grid-cols-6">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Yes price</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.yesPrice)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">No price</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.noPrice)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Yes entry</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.performance?.yesEntryPrice ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">No entry</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.performance?.noEntryPrice ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Pair entry</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.performance?.pairEntryPrice ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Best yes mid</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.marketView?.yesMid ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Cost basis</div>
                    <div className="mt-1 text-white">
                      {position.costBasis != null ? money.format(position.costBasis) : "--"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Realized</div>
                    <div className={`mt-1 ${pnlTone(position.performance?.realizedPnl ?? 0)}`}>
                      {money.format(position.performance?.realizedPnl ?? 0)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">History</div>
                    <div className={`mt-1 ${position.performance?.partialHistory ? "text-amber-200" : "text-white"}`}>
                      {position.performance?.partialHistory ? "Partial" : "Covered"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Paired</div>
                    <div className="mt-1 text-white">
                      {formatContracts(position.performance?.pairedContracts ?? 0)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Depth</div>
                    <div className="mt-1 text-white">{formatContracts(position.marketView?.totalDepth ?? 0)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Pairs minted</div>
                    <div className="mt-1 text-white">{formatContracts(position.marketView?.totalPairsMinted ?? 0)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Settlement</div>
                    <div className="mt-1 text-white">
                      {formatUsdcBaseUnits(position.settlementPrice ?? position.marketView?.settlementPrice ?? null)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Action</div>
                    {position.redeemable > 0 && canMutateSelectedDesk ? (
                      <button
                        onClick={() => void handleRedeem(position)}
                        className="mt-1 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-100 transition hover:border-emerald-200/40 hover:text-white"
                      >
                        {position.settled ? "Redeem" : "Exit complete set"}
                      </button>
                    ) : (
                      <div className="mt-1 text-stone-500">
                        {position.redeemable === 0
                          ? position.settled ? "Nothing redeemable" : "Single-leg position"
                          : "Read-only desk"}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-stone-400">
                  <span>
                    {position.settled
                      ? "Settled contracts redeem at fixed $1.00 on the winning side."
                      : "Open positions are marked from the live Yes/USDC order book."}
                  </span>
                  {actionState[position.market.toBase58()] && (
                    <span className="text-stone-300">{actionState[position.market.toBase58()]}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
