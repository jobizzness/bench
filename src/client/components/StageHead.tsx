import { useBenchState } from "./context.js";

export function StageHead() {
  const { rows, selectedId } = useBenchState();
  const row = rows.find((r) => r.id === selectedId);
  if (!row) return null;

  return (
    <header id="stage-head">
      <span id="stage-label">{row.label}</span>
      <span id="stage-status">{`${row.status.replace(/_/g, " ")} · ${row.detail}`}</span>
    </header>
  );
}
