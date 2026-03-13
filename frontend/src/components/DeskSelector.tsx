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
    <label>
      {label}:{" "}
      <select
        value={selectedDeskId}
        onChange={(event) => onChange(event.target.value)}
      >
        {desks.map((desk) => (
          <option key={desk.id} value={desk.id}>
            {desk.label}
          </option>
        ))}
      </select>
    </label>
  );
}
