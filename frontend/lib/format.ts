// Number and money formatting for the dashboard.
// All figures use tabular-nums; magnitudes collapse to K/M/B for compactness.

// Format a monetary value. Non-USD units render with an ISO prefix so
// cross-ticker readers can distinguish CAD/KRW/JPY/etc. from USD — the
// underlying data is *not* FX-normalized, and silently mixing figures
// across currencies is the failure mode we're guarding against.
//
// `storedInMillions` says the raw value is already in millions (typical
// for our metric-store convention on keys ending in `_m`). Callers with
// a metric key should compute this from `key.endsWith("_m")`.
export function fmtMoney(
  value: number | null,
  unit = "USD",
  storedInMillions = false,
): string {
  if (value === null) return "—";
  const abs = Math.abs(value);
  let suffix = "";
  let out = value;
  // Legacy unit strings ("USD_m", "EUR_m") also imply millions.
  const millions =
    storedInMillions ||
    unit.endsWith("_m") ||
    unit === "USD_m" ||
    unit === "EUR_m";
  if (millions) {
    if (abs >= 1_000_000) {
      out = value / 1_000_000;
      suffix = "T";
    } else if (abs >= 1_000) {
      out = value / 1_000;
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
  const rounded =
    Math.abs(out) < 10
      ? out.toFixed(2)
      : Math.abs(out) < 100
      ? out.toFixed(1)
      : Math.round(out).toString();
  const currencyCode = unit.endsWith("_m") ? unit.slice(0, -2) : unit;
  const prefix =
    currencyCode && currencyCode !== "USD" && /^[A-Z]{3}$/.test(currencyCode)
      ? `${currencyCode} `
      : "";
  return `${prefix}${rounded}${suffix}`;
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
