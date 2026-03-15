import type { ReactNode } from "react";

interface LifecycleIndicatorProps {
  status: string; // "created" | "frozen" | "settled"
  closeTime: number; // unix timestamp
}

const STEPS = ["Created", "Trading", "Frozen", "Settled"] as const;

function deriveStep(status: string, closeTime: number): number {
  if (status === "settled") return 3;
  if (status === "frozen") return 2;
  const now = Math.floor(Date.now() / 1000);
  return now < closeTime ? 1 : 0;
}

function state(i: number, current: number): string {
  if (i < current) return "past";
  if (i === current) return "current";
  return "future";
}

export function LifecycleIndicator({ status, closeTime }: LifecycleIndicatorProps) {
  const current = deriveStep(status, closeTime);

  const items: ReactNode[] = [];
  STEPS.forEach((step, i) => {
    if (i > 0) items.push(<span key={`sep-${i}`} data-lc-sep="" />);
    items.push(
      <span key={step} data-lc-step={state(i, current)}>
        <span data-lc-dot="" />
        {step}
      </span>
    );
  });

  return <nav data-lifecycle>{items}</nav>;
}
