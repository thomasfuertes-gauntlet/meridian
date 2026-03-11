import type { DeskWallet } from "../lib/dev-wallets";

interface DeskSelectorProps {
  desks: DeskWallet[];
  selectedDeskId: string;
  onChange: (deskId: string) => void;
  label?: string;
}

export function DeskSelector({
  desks,
  selectedDeskId,
  onChange,
  label = "Desk",
}: DeskSelectorProps) {
  return (
    <label className="inline-flex items-center gap-3 rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-300">
      <span>{label}</span>
      <select
        value={selectedDeskId}
        onChange={(event) => onChange(event.target.value)}
        className="bg-transparent text-white outline-none"
      >
        {desks.map((desk) => (
          <option key={desk.id} value={desk.id} className="bg-stone-950 text-white">
            {desk.label}
          </option>
        ))}
      </select>
    </label>
  );
}
