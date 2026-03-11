import { USDC_PER_PAIR } from "./constants";

export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatUsdcBaseUnits(value: number | null): string {
  if (value == null) return "--";
  return money.format(value / USDC_PER_PAIR);
}

export function formatContracts(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTimestamp(unixSeconds: number | null): string {
  if (!unixSeconds) return "--";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelativePublishTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "Unavailable";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}
