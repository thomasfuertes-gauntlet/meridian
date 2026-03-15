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

export function LifecycleIndicator({ status, closeTime }: LifecycleIndicatorProps) {
  const current = deriveStep(status, closeTime);

  return (
    <ol data-lifecycle>
      {STEPS.map((step, i) => (
        <li
          key={step}
          data-state={i < current ? "past" : i === current ? "current" : "future"}
        >
          {i > 0 && <span data-separator />}
          {step}
        </li>
      ))}
    </ol>
  );
}
