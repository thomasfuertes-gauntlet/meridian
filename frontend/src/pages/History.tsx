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
import { ACTIVITY_LIMIT, type Ticker } from "../lib/constants";
import { deskLabelForPubkey, getDeskWallets } from "../lib/dev-wallets";

function shortKey(value: string | null): string {
  if (!value) return "--";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sideTone(side: "yes" | "no" | null): "green" | "red" | "muted" {
  if (side === "yes") return "green";
  if (side === "no") return "red";
  return "muted";
}

export function History() {
  const wallet = useAnchorWallet();
  const { data, loading, error } = useActivityFeed(ACTIVITY_LIMIT);
  const [tickerFilter, setTickerFilter] = useState<Ticker | "all">("all");
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");
  const desks = useMemo(() => getDeskWallets(wallet?.publicKey), [wallet]);
  const [deskFilter, setDeskFilter] = useState<string>("all");

  const walletKey = wallet?.publicKey.toBase58() ?? null;

  const selectedDesk =
    viewMode === "all" && deskFilter !== "all"
      ? (desks.find((entry) => entry.id === deskFilter) ?? null)
      : null;

  const filtered = useMemo(() => {
    return data.filter((item) => {
      if (tickerFilter !== "all" && item.ticker !== tickerFilter) return false;
      if (viewMode === "mine") {
        if (walletKey && item.user !== walletKey) return false;
      } else {
        if (selectedDesk && item.user !== selectedDesk.publicKey.toBase58()) return false;
      }
      return true;
    });
  }, [data, tickerFilter, viewMode, walletKey, selectedDesk]);

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
    <>
      <section>
        <h1>History</h1>
        <p>Confirmed Meridian transactions decoded from on-chain instructions.</p>
        <dl>
          <dt>Events</dt>
          <dd>{compact.format(stats.total)}</dd>
          <dt>Trades</dt>
          <dd>{compact.format(stats.trades)}</dd>
          <dt>Redeems</dt>
          <dd>{compact.format(stats.redeems)}</dd>
          <dt>Success</dt>
          <dd>{stats.total === 0 ? "--" : `${Math.round((stats.success / stats.total) * 100)}%`}</dd>
        </dl>

        <nav>
          <button
            data-view="mine"
            data-active={viewMode === "mine" ? "true" : undefined}
            onClick={() => setViewMode("mine")}
          >
            My Trades
          </button>
          <button
            data-view="all"
            data-active={viewMode === "all" ? "true" : undefined}
            onClick={() => setViewMode("all")}
          >
            All Activity
          </button>
        </nav>

        <nav>
          <button
            data-active={tickerFilter === "all" ? "true" : undefined}
            onClick={() => setTickerFilter("all")}
          >
            All tickers
          </button>
          {getActivityTickers().map((ticker) => (
            <button
              key={ticker}
              data-active={tickerFilter === ticker ? "true" : undefined}
              onClick={() => setTickerFilter(ticker)}
            >
              {ticker}
            </button>
          ))}
        </nav>

        {viewMode === "all" && (
          <nav>
            <button
              data-active={deskFilter === "all" ? "true" : undefined}
              onClick={() => setDeskFilter("all")}
            >
              All desks
            </button>
            <DeskSelector
              desks={desks}
              selectedDeskId={selectedDesk?.id ?? desks[0]?.id ?? "all"}
              onChange={setDeskFilter}
              label="Wallet"
            />
          </nav>
        )}
      </section>

      <section>
        {error && <p><mark data-tone="red">{error}</mark></p>}

        {viewMode === "mine" && !walletKey && (
          <p><mark data-tone="muted">Connect wallet to see your trade history.</mark></p>
        )}

        {loading && filtered.length === 0 ? (
          <p><mark data-tone="muted">Loading confirmed activity...</mark></p>
        ) : filtered.length === 0 && (viewMode !== "mine" || walletKey) ? (
          <p><mark data-tone="muted">No activity matched the current filters.</mark></p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Ticker</th>
                <th>Strike</th>
                <th>User</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Notional</th>
                <th>Status</th>
                <th>Sig</th>
                <th>Slot</th>
                <th>Market</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const price = formatActivityPrice(item);
                const notional = formatActivityNotional(item);
                return (
                  <tr key={`${item.signature}-${item.instructionName}-${item.slot}`}>
                    <td><time>{formatTimestamp(item.blockTime)}</time></td>
                    <td>{item.label}</td>
                    <td>{item.ticker ?? "--"}</td>
                    <td>{formatUsdcBaseUnits(item.strikePrice)}</td>
                    <td>
                      <span>{deskLabelForPubkey(item.user, desks) ?? shortKey(item.user)}</span>
                      {" "}
                      <kbd>{shortKey(item.user)}</kbd>
                    </td>
                    <td>{item.side ? <mark data-tone={sideTone(item.side)}>{item.side}</mark> : "--"}</td>
                    <td>{item.amount != null ? formatContracts(item.amount) : "--"}</td>
                    <td>{formatUsdcBaseUnits(price)}</td>
                    <td>{notional != null ? money.format(notional) : "--"}</td>
                    <td><mark data-tone={item.success ? "green" : "red"}>{item.success ? "confirmed" : "failed"}</mark></td>
                    <td><kbd>{shortKey(item.signature)}</kbd></td>
                    <td>{compact.format(item.slot)}</td>
                    <td>
                      {item.marketAddress && item.ticker && (
                        <Link to={`/markets/${item.ticker}`}>Open</Link>
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
