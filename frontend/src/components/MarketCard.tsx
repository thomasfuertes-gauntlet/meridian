import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { TickerSnapshot } from "../lib/market-data";
import { usePriceHistory } from "../lib/usePriceHistory";
import { PriceSparkline } from "./PriceSparkline";
import { formatContracts, formatRelativePublishTime, formatUsdcBaseUnits } from "../lib/format";

interface MarketCardProps {
  snapshot: TickerSnapshot;
}

export function MarketCard({ snapshot }: MarketCardProps) {
  const navigate = useNavigate();
  // Separate history for CLOB mid-price (moves with bot activity, even outside market hours)
  const { history: clobHistory, push: pushClob } = usePriceHistory(`${snapshot.ticker}-clob`);

  // Feed CLOB mid-price into sparkline history
  useEffect(() => {
    if (snapshot.topYesMid != null) pushClob(snapshot.topYesMid / 1_000_000);
  }, [snapshot.topYesMid, pushClob]);

  return (
    <article onClick={() => navigate(`/markets/${snapshot.ticker}`)} style={{ cursor: "pointer" }}>
      <h3>
        {snapshot.ticker}{" "}
        <mark data-tone={snapshot.status}>{snapshot.status}</mark>
      </h3>
      <p>{snapshot.company}</p>

      <div>
        <p>
          {snapshot.latestPrice != null ? `$${snapshot.latestPrice.toFixed(2)}` : "--"}
        </p>
        <small>Reference spot</small>
        {snapshot.topYesMid != null && (
          <p>Yes mid <output>{formatUsdcBaseUnits(snapshot.topYesMid)}</output></p>
        )}
        {clobHistory.length >= 2 && (
          <PriceSparkline prices={[...clobHistory]} width={104} height={40} color="#7dd3fc" />
        )}
      </div>

      <dl>
        <dt>Oracle</dt>
        <dd>{snapshot.publishTime ? formatRelativePublishTime(snapshot.publishTime) : "offline"}</dd>
        <dt>Strikes</dt>
        <dd>{snapshot.marketCount || "--"}</dd>
        <dt>Open interest</dt>
        <dd>{formatContracts(snapshot.totalOpenInterest)}</dd>
        <dt>Nearest strike</dt>
        <dd>{snapshot.nearestStrike != null ? formatUsdcBaseUnits(snapshot.nearestStrike) : "--"}</dd>
      </dl>
    </article>
  );
}
