export function presentKeyValues(data: Record<string, unknown>): string {
  return `${Object.entries(data)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join("\n")}\n`;
}

export function presentList(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.\n";
  return `${rows.map((row) => Object.values(row).map(formatValue).join("\t")).join("\n")}\n`;
}

function formatValue(value: unknown): string {
  if (value === null) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
