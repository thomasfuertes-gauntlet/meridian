import { useMemo, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  formatActivityPrice,
  useActivityFeed,
} from "../lib/activity";
import { formatContracts, formatTimestamp, formatUsdcBaseUnits } from "../lib/format";
import { ACTIVITY_LIMIT } from "../lib/constants";

function sideTone(side: "yes" | "no" | null): "green" | "red" | "muted" {
  if (side === "yes") return "green";
  if (side === "no") return "red";
  return "muted";
}

export function History() {
  const wallet = useAnchorWallet();
  const { data, loading, loadingMore, hasMore, error, loadMore } = useActivityFeed(ACTIVITY_LIMIT);
  const [viewMode, setViewMode] = useState<"mine" | "all">("mine");

  const walletKey = wallet?.publicKey.toBase58() ?? null;

  const filtered = useMemo(() => {
    if (viewMode === "all") return data;
    if (!walletKey) return [];
    return data.filter((item) => item.user === walletKey);
  }, [data, viewMode, walletKey]);

  return (
    <>
      <section>
        <h1>Trade history</h1>
        <nav>
          <button
            data-active={viewMode === "mine" ? "true" : undefined}
            onClick={() => setViewMode("mine")}
          >
            My Trades
          </button>
          <button
            data-active={viewMode === "all" ? "true" : undefined}
            onClick={() => setViewMode("all")}
          >
            All Activity
          </button>
        </nav>
      </section>

      <section>
        {error && <p><mark data-tone="red">{error}</mark></p>}

        {viewMode === "mine" && !walletKey && (
          <p><mark data-tone="muted">Connect wallet to see your trade history.</mark></p>
        )}

        {loading && filtered.length === 0 ? (
          <p><mark data-tone="muted">Loading...</mark></p>
        ) : filtered.length === 0 && (viewMode !== "mine" || walletKey) ? (
          <p><mark data-tone="muted">No trades found.</mark></p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Ticker</th>
                <th>Strike</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={`${item.signature}-${item.instructionName}-${item.slot}`}>
                  <td><time>{formatTimestamp(item.blockTime)}</time></td>
                  <td>{item.label}</td>
                  <td>{item.ticker ?? "--"}</td>
                  <td>{formatUsdcBaseUnits(item.strikePrice)}</td>
                  <td>{item.side ? <mark data-tone={sideTone(item.side)}>{item.side}</mark> : "--"}</td>
                  <td>{item.amount != null ? formatContracts(item.amount) : "--"}</td>
                  <td>{formatUsdcBaseUnits(formatActivityPrice(item))}</td>
                  <td><mark data-tone={item.success ? "green" : "red"}>{item.success ? "confirmed" : "failed"}</mark></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hasMore && !loading && (
          <button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading..." : `Load more (${filtered.length} shown)`}
          </button>
        )}
      </section>
    </>
  );
}
