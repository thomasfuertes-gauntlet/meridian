import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getProgram, getReadOnlyProgram } from "../lib/anchor";
import { DeskSelector } from "../components/DeskSelector";
import { MAG7, type Ticker } from "../lib/constants";
import { money, formatContracts, formatUsdcBaseUnits } from "../lib/format";
import { useMarketData } from "../lib/ws-market-data";
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

function outcomeTone(outcome: Position["outcome"]): "green" | "red" | "blue" {
  switch (outcome) {
    case "yesWins": return "green";
    case "noWins": return "red";
    default: return "blue";
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
    case "yesWins": return "Yes won";
    case "noWins": return "No won";
    default: return "Open";
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

function pnlTone(value: number | null): "green" | "red" | "muted" {
  if (value == null) return "muted";
  if (value > 0) return "green";
  if (value < 0) return "red";
  return "muted";
}

function hasPartialHistory(positions: Array<{ performance?: PositionPerformance }>): boolean {
  return positions.some((position) => position.performance?.partialHistory);
}

export function Portfolio() {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const { data } = useMarketData();
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
    <>
      <section>
        <h1>Live positions and exits</h1>
        <dl>
          <dt>Yes tokens</dt>
          <dd>{formatContracts(totals.yes)}</dd>
          <dt>No tokens</dt>
          <dd>{formatContracts(totals.no)}</dd>
          <dt>Mark value</dt>
          <dd>{money.format(totals.markValue)}</dd>
          <dt>Cost basis</dt>
          <dd>{money.format(totals.costBasis)}</dd>
          <dt>Unrealized P&amp;L</dt>
          <dd><mark data-tone={pnlTone(totals.unrealizedPnl)}>{money.format(totals.unrealizedPnl)}</mark></dd>
          <dt>Realized P&amp;L</dt>
          <dd><mark data-tone={pnlTone(totals.realizedPnl)}>{money.format(totals.realizedPnl)}</mark></dd>
          <dt>Redeemable now</dt>
          <dd>{money.format(totals.redeemable)} <small>Includes settled winners and pre-settlement complete sets.</small></dd>
        </dl>
      </section>

      <section>
        <nav>
          <DeskSelector
            desks={desks}
            selectedDeskId={selectedDesk?.id ?? desks[0]?.id ?? ""}
            onChange={setSelectedDeskId}
            label="Wallet"
          />
          <button
            onClick={loadPositions}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </nav>

        <p>
          {selectedDesk ? (
            canMutateSelectedDesk
              ? `Viewing ${selectedDesk.label}. Redeem and complete-set exit actions are enabled.`
              : `Viewing ${selectedDesk.label} in read-only mode. Connect that wallet to sign exits.`
          ) : (
            "No wallet selected."
          )}
        </p>

        {partialHistoryVisible && (
          <p><mark data-tone="blue">Cost basis and unrealized P&amp;L are hidden for positions whose current inventory is older than the fetched transaction window or came from non-canonical flows.</mark></p>
        )}

        {error && <p><mark data-tone="red">{error}</mark></p>}

        {enriched.length === 0 ? (
          <p><mark data-tone="muted">{loading ? "Loading wallet positions..." : "No positions found for this wallet."}</mark></p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Strike</th>
                <th>Status</th>
                <th>Yes</th>
                <th>No</th>
                <th>Yes price</th>
                <th>No price</th>
                <th>Mark</th>
                <th>Cost</th>
                <th>U. P&amp;L</th>
                <th>R. P&amp;L</th>
                <th>Yes entry</th>
                <th>No entry</th>
                <th>Pair entry</th>
                <th>Best mid</th>
                <th>History</th>
                <th>Paired</th>
                <th>Depth</th>
                <th>Pairs minted</th>
                <th>Settlement</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((position) => {
                const actionKey = position.market.toBase58();
                return (
                  <tr key={actionKey}>
                    <td>{position.ticker}</td>
                    <td>{formatUsdcBaseUnits(position.strikePrice)}</td>
                    <td><mark data-tone={outcomeTone(position.outcome)}>{outcomeLabel(position.outcome)}</mark></td>
                    <td>{formatContracts(position.yesBalance)}</td>
                    <td>{formatContracts(position.noBalance)}</td>
                    <td>{formatUsdcBaseUnits(position.yesPrice)}</td>
                    <td>{formatUsdcBaseUnits(position.noPrice)}</td>
                    <td>{money.format(position.markValue)}</td>
                    <td>{position.costBasis != null ? money.format(position.costBasis) : "--"}</td>
                    <td><mark data-tone={pnlTone(position.unrealizedPnl)}>{position.unrealizedPnl != null ? money.format(position.unrealizedPnl) : "--"}</mark></td>
                    <td><mark data-tone={pnlTone(position.performance?.realizedPnl ?? 0)}>{money.format(position.performance?.realizedPnl ?? 0)}</mark></td>
                    <td>{formatUsdcBaseUnits(position.performance?.yesEntryPrice ?? null)}</td>
                    <td>{formatUsdcBaseUnits(position.performance?.noEntryPrice ?? null)}</td>
                    <td>{formatUsdcBaseUnits(position.performance?.pairEntryPrice ?? null)}</td>
                    <td>{formatUsdcBaseUnits(position.marketView?.yesMid ?? null)}</td>
                    <td>
                      {position.performance?.partialHistory
                        ? <mark data-tone="blue">Partial</mark>
                        : "Covered"}
                    </td>
                    <td>{formatContracts(position.performance?.pairedContracts ?? 0)}</td>
                    <td>{formatContracts(position.marketView?.totalDepth ?? 0)}</td>
                    <td>{formatContracts(position.marketView?.totalPairsMinted ?? 0)}</td>
                    <td>{formatUsdcBaseUnits(position.settlementPrice ?? position.marketView?.settlementPrice ?? null)}</td>
                    <td>
                      {position.redeemable > 0 && canMutateSelectedDesk ? (
                        <button onClick={() => void handleRedeem(position)}>
                          {position.settled ? "Redeem" : "Exit complete set"}
                        </button>
                      ) : (
                        <mark data-tone="muted">
                          {position.redeemable === 0
                            ? position.settled ? "Nothing redeemable" : "Single-leg"
                            : "Read-only"}
                        </mark>
                      )}
                      {actionState[actionKey] && (
                        <small> {actionState[actionKey]}</small>
                      )}
                    </td>
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
