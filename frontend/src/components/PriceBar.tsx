import { USDC_PER_PAIR } from "../lib/constants";

interface PriceBarProps {
  yesMid: number | null; // base units, e.g. 650000
  variant?: "full" | "compact";
}

export function PriceBar({ yesMid, variant = "full" }: PriceBarProps) {
  if (yesMid == null) {
    return <div data-pricebar={variant} style={{ background: "var(--bg-elevated)", height: variant === "compact" ? 6 : 28, borderRadius: "var(--radius-sm)" }} />;
  }

  const yesPct = (yesMid / USDC_PER_PAIR) * 100;
  const noPct = 100 - yesPct;
  const yesPrice = (yesMid / USDC_PER_PAIR).toFixed(2);
  const noPrice = ((USDC_PER_PAIR - yesMid) / USDC_PER_PAIR).toFixed(2);

  return (
    <div data-pricebar={variant}>
      <span data-side="yes" style={{ width: `${yesPct}%` }}>
        {variant === "full" && <>Yes ${yesPrice} ({yesPct.toFixed(0)}%)</>}
      </span>
      <span data-side="no" style={{ width: `${noPct}%` }}>
        {variant === "full" && <>No ${noPrice}</>}
      </span>
    </div>
  );
}
