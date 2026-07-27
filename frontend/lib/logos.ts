// Ticker labeling helpers. External-logo lookup (clearbit) was removed —
// TickerLogo now renders a text chip with the ticker's base symbol. This
// file only exposes the initials fallback for when a ticker string is
// missing or otherwise unusable.

export function tickerInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
