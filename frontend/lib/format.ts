// Number and money formatting for the dashboard.
// All figures use tabular-nums; magnitudes collapse to K/M/B for compactness.

export function fmtMoney(value: number | null, unit = "USD"): string {
  if (value === null) return "—";
  const abs = Math.abs(value);
  let suffix = "";
  let out = value;
  if (unit.endsWith("_m") || unit === "USD_m" || unit === "EUR_m") {
    // stored as millions
    if (abs >= 1000) {
      out = value / 1000;
      suffix = "B";
    } else {
      suffix = "M";
    }
  } else if (abs >= 1_000_000_000) {
    out = value / 1_000_000_000;
    suffix = "B";
  } else if (abs >= 1_000_000) {
    out = value / 1_000_000;
    suffix = "M";
  } else if (abs >= 1_000) {
    out = value / 1_000;
    suffix = "K";
  }
  const rounded = Math.abs(out) < 10
    ? out.toFixed(2)
    : Math.abs(out) < 100
    ? out.toFixed(1)
    : Math.round(out).toString();
  return `${rounded}${suffix}`;
}

export function fmtNumber(value: number | null, dp = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: dp,
    minimumFractionDigits: dp,
  });
}

export function fmtPct(value: number | null, dp = 1): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(dp)}%`;
}

export function fmtSurprisePct(value: number | null): string {
  if (value === null) return "n/a — no estimate";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}

export function fmtRelative(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffD = Math.round(diffHr / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return fmtDateShort(iso);
}

export function fmtDaysUntil(days: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return "today";
  return `in ${days}d`;
}
