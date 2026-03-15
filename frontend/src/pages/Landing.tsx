import { useNavigate } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { SettlementCountdown } from "../components/SettlementCountdown";
import { useMarketData } from "../lib/use-market-data";
import { MAG7 } from "../lib/constants";

export function Landing() {
  const navigate = useNavigate();
  const { data, loading } = useMarketData();
  const snapshots = data?.tickerSnapshots ?? [];

  return (
    <>
      {/* Hero */}
      <section className="landing-hero">
        <h1>Trade binary outcomes on MAG7 stocks</h1>
        <p>
          Will NVDA close above $180 today? Buy <mark data-tone="green">Yes</mark> or{" "}
          <mark data-tone="red">No</mark>. $1 payout if you're right.
        </p>
        <div className="landing-hero-actions">
          <WalletMultiButton />
          <SettlementCountdown />
        </div>
      </section>

      {/* Live Prices */}
      <section>
        <h2>Live prices</h2>
        <div className="landing-grid">
          {MAG7.map((entry) => {
            const snap = snapshots.find((s) => s.ticker === entry.ticker);
            const price = snap?.latestPrice;
            const strikes = snap?.marketCount ?? 0;

            return (
              <article
                key={entry.ticker}
                onClick={() => navigate(`/markets/${entry.ticker}`)}
                style={{ cursor: "pointer" }}
              >
                <h3>{entry.ticker}</h3>
                <p>{entry.name}</p>
                <p style={{ fontSize: "1.5rem", fontFamily: "var(--mono)" }}>
                  {loading
                    ? "..."
                    : price != null
                      ? `$${price.toFixed(2)}`
                      : "--"}
                </p>
                <small>
                  {strikes} strike{strikes !== 1 ? "s" : ""}
                </small>
              </article>
            );
          })}
        </div>
      </section>

      {/* How It Works */}
      <section>
        <h2>How it works</h2>
        <div className="landing-steps">
          <div>
            <kbd>1</kbd>
            <dt>Pick a stock</dt>
            <dd>Choose from the Magnificent 7</dd>
          </div>
          <div>
            <kbd>2</kbd>
            <dt>Choose a strike</dt>
            <dd>Will it close above or below?</dd>
          </div>
          <div>
            <kbd>3</kbd>
            <dt>Win $1</dt>
            <dd>You pay $0.55. You win $1.00 if NVDA closes above $180.</dd>
          </div>
        </div>
      </section>
    </>
  );
}
