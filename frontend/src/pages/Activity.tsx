import { useMemo, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { Link } from "react-router-dom";
import { DeskSelector } from "../components/DeskSelector";
import {
  formatActivityNotional,
  formatActivityPrice,
  getActivityTickers,
  useActivityFeed,
} from "../lib/activity";
import { compact, formatContracts, formatTimestamp, formatUsdcBaseUnits, money } from "../lib/format";
import type { Ticker } from "../lib/constants";
import { deskLabelForPubkey, getDeskWallets } from "../lib/dev-wallets";

function shortKey(value: string | null): string {
  if (!value) return "--";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sideTone(side: "yes" | "no" | null): string {
  if (side === "yes") return "text-emerald-300";
  if (side === "no") return "text-rose-300";
  return "text-zinc-400";
}

export function Activity() {
  const wallet = useAnchorWallet();
  const { data, loading, error } = useActivityFeed(120);
  const [tickerFilter, setTickerFilter] = useState<Ticker | "all">("all");
  const desks = useMemo(() => getDeskWallets(wallet?.publicKey), [wallet]);
  const [deskFilter, setDeskFilter] = useState<string>("all");

  const selectedDesk = deskFilter === "all"
    ? null
    : desks.find((entry) => entry.id === deskFilter) ?? null;

  const filtered = useMemo(() => {
    return data.filter((item) => {
      if (tickerFilter !== "all" && item.ticker !== tickerFilter) return false;
      if (selectedDesk && item.user !== selectedDesk.publicKey.toBase58()) return false;
      return true;
    });
  }, [data, selectedDesk, tickerFilter]);

  const stats = useMemo(() => {
    return filtered.reduce(
      (acc, item) => {
        acc.total += 1;
        if (item.success) acc.success += 1;
        if (item.kind === "buyYes" || item.kind === "sellYes") acc.trades += 1;
        if (item.kind === "redeem") acc.redeems += 1;
        return acc;
      },
      { total: 0, success: 0, trades: 0, redeems: 0 }
    );
  }, [filtered]);

  return (
    <div className="space-y-8">
      <section className="terminal-panel p-6">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">History</div>
            <h1 className="mt-2 font-display text-4xl text-white">Activity tape</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400">
              Confirmed Meridian transactions decoded from on-chain instructions. Filter by ticker for the market tape or switch to any deterministic desk wallet for the account view.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Events</div>
              <div className="mt-2 font-display text-2xl text-white">{compact.format(stats.total)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Trades</div>
              <div className="mt-2 font-display text-2xl text-white">{compact.format(stats.trades)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Redeems</div>
              <div className="mt-2 font-display text-2xl text-white">{compact.format(stats.redeems)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Success</div>
              <div className="mt-2 font-display text-2xl text-white">
                {stats.total === 0 ? "--" : `${Math.round((stats.success / stats.total) * 100)}%`}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setTickerFilter("all")}
              className={`rounded-full px-4 py-2 text-sm transition ${
                tickerFilter === "all"
                  ? "bg-white text-stone-950"
                  : "border border-white/10 text-zinc-300 hover:border-white/25 hover:text-white"
              }`}
            >
              All tickers
            </button>
            {getActivityTickers().map((ticker) => (
              <button
                key={ticker}
                onClick={() => setTickerFilter(ticker)}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  tickerFilter === ticker
                    ? "bg-white text-stone-950"
                    : "border border-white/10 text-zinc-300 hover:border-white/25 hover:text-white"
                }`}
              >
                {ticker}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setDeskFilter("all")}
              className={`rounded-full px-4 py-2 text-sm transition ${
                deskFilter === "all"
                  ? "bg-white text-stone-950"
                  : "border border-white/10 text-zinc-300 hover:border-white/25 hover:text-white"
              }`}
            >
              All desks
            </button>
            <DeskSelector
              desks={desks}
              selectedDeskId={selectedDesk?.id ?? desks[0]?.id ?? "all"}
              onChange={setDeskFilter}
              label="Wallet"
            />
          </div>
        </div>
      </section>

      <section className="terminal-panel p-6">
        {error && (
          <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        {loading && filtered.length === 0 ? (
          <div className="rounded-[1.5rem] border border-dashed border-white/10 px-6 py-12 text-center text-zinc-400">
            Loading confirmed activity...
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-[1.5rem] border border-dashed border-white/10 px-6 py-12 text-center text-zinc-400">
            No activity matched the current filters.
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((item) => {
              const price = formatActivityPrice(item);
              const notional = formatActivityNotional(item);
              return (
                <div
                  key={`${item.signature}-${item.instructionName}-${item.slot}`}
                  className="rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-5"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="text-lg font-semibold text-white">{item.label}</div>
                        <span className={`text-xs uppercase tracking-[0.22em] ${item.success ? "text-emerald-300" : "text-rose-300"}`}>
                          {item.success ? "confirmed" : "failed"}
                        </span>
                        {item.side && (
                          <span className={`text-xs uppercase tracking-[0.22em] ${sideTone(item.side)}`}>
                            {item.side}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-3 text-sm text-zinc-400">
                        <span>{item.ticker ?? "Unknown ticker"}</span>
                        <span>•</span>
                        <span>{formatUsdcBaseUnits(item.strikePrice)}</span>
                        <span>•</span>
                        <span>{formatTimestamp(item.blockTime)}</span>
                      </div>
                    </div>
                    <div className="text-sm text-zinc-400">
                      {item.marketAddress && item.ticker && (
                        <Link to={`/markets/${item.ticker}`} className="text-amber-200 transition hover:text-amber-100">
                          Open market
                        </Link>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 text-sm text-zinc-300 sm:grid-cols-2 xl:grid-cols-6">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">User</div>
                      <div className="mt-1 text-white">
                        {deskLabelForPubkey(item.user, desks) ?? shortKey(item.user)}
                      </div>
                      <div className="font-mono text-xs text-zinc-500">{shortKey(item.user)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Quantity</div>
                      <div className="mt-1 text-white">{item.amount != null ? formatContracts(item.amount) : "--"}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Price</div>
                      <div className="mt-1 font-mono text-white">{formatUsdcBaseUnits(price)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Notional</div>
                      <div className="mt-1 text-white">{notional != null ? money.format(notional) : "--"}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Signature</div>
                      <div className="mt-1 font-mono text-white">{shortKey(item.signature)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Slot</div>
                      <div className="mt-1 text-white">{compact.format(item.slot)}</div>
                    </div>
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
