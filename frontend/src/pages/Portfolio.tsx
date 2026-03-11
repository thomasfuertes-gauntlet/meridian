import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { getProgram } from "../lib/anchor";
import { MAG7, type Ticker } from "../lib/constants";
import { money, formatContracts, formatUsdcBaseUnits } from "../lib/format";
import { useMarketUniverse } from "../lib/market-data";
import { fetchPositions, type Position } from "../lib/portfolio";

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

export function Portfolio() {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const { data } = useMarketUniverse(20_000);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    if (!wallet) {
      setPositions([]);
      return;
    }

    setLoading(true);
    try {
      const program = getProgram(wallet);
      const next = await fetchPositions(program, connection, wallet.publicKey);
      setPositions(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load positions");
    } finally {
      setLoading(false);
    }
  }, [wallet, connection]);

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
      return {
        ...position,
        marketView: market,
        markValue: markValue(position, mid),
      };
    });
  }, [data, positions]);

  const totals = useMemo(() => {
    return enriched.reduce(
      (acc, position) => {
        acc.yes += position.yesBalance;
        acc.no += position.noBalance;
        acc.markValue += position.markValue;
        return acc;
      },
      { yes: 0, no: 0, markValue: 0 }
    );
  }, [enriched]);

  if (!wallet) {
    return (
      <div className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-8 text-center">
        <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Portfolio</div>
        <h1 className="mt-3 text-3xl font-semibold text-white">Connect a wallet to inspect holdings</h1>
        <p className="mt-4 text-sm leading-7 text-stone-400">
          Phase 1.5 adds wallet-backed read paths only. The portfolio page reads token balances and
          market outcomes without reintroducing the old mutation-heavy trade surface.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-3">
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
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-stone-950/85 p-6">
        <div className="mb-6 flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-stone-500">Wallet holdings</div>
            <h1 className="mt-2 text-3xl font-semibold text-white">Portfolio read model</h1>
          </div>
          <button
            onClick={loadPositions}
            disabled={loading}
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-stone-200 transition hover:border-amber-200/40 hover:text-white disabled:opacity-60"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

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
                        {position.outcome}
                      </span>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
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
                  </div>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm text-stone-300">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Best yes mid</div>
                    <div className="mt-1 font-mono text-white">
                      {formatUsdcBaseUnits(position.marketView?.yesMid ?? null)}
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
                    <div className="mt-1 text-white">{formatUsdcBaseUnits(position.marketView?.settlementPrice ?? null)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
