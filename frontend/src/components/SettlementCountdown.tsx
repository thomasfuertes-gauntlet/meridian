import { useState, useEffect } from "react";

function getNextSettlement(): Date {
  const now = new Date();
  // 4:00 PM ET = 21:00 UTC (EST) or 20:00 UTC (EDT)
  // Approximate: use America/New_York for correct DST handling
  const et = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const target = new Date(et);
  target.setHours(16, 0, 0, 0);
  if (et >= target) {
    target.setDate(target.getDate() + 1);
  }
  // Skip weekends
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }
  // Convert back to UTC-relative
  const diff = target.getTime() - et.getTime();
  return new Date(now.getTime() + diff);
}

export function SettlementCountdown() {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function update() {
      const target = getNextSettlement();
      const diff = target.getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("Settling...");
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(
        `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
      );
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300">
      Next settle <span className="font-mono text-amber-200">{timeLeft}</span>
    </div>
  );
}
