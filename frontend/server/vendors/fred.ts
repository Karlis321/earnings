// FRED (Federal Reserve Economic Data) — US + ECB rates + bond yields.
// Requires FRED_API_KEY. Series IDs from backend/reference/news.txt.txt.

export interface FredObservation {
  seriesId: string;
  label: string;
  unit: string;
  value: number;
  prev: number;
  change: number;
  date: string;
}

async function fredLatest(
  seriesId: string,
  label: string,
  unit: string,
): Promise<FredObservation | null> {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=2`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = (await r.json()) as {
      observations?: Array<{ value: string; date: string }>;
    };
    const obs = (j.observations ?? []).filter((o) => o.value !== ".");
    if (obs.length === 0) return null;
    const latest = parseFloat(obs[0].value);
    const prev = obs[1] ? parseFloat(obs[1].value) : latest;
    return {
      seriesId,
      label,
      unit,
      value: latest,
      prev,
      change: latest - prev,
      date: obs[0].date,
    };
  } catch {
    return null;
  }
}

// The full set from news.txt.txt.
const RATE_SERIES: Array<{ id: string; label: string; unit: string }> = [
  { id: "DFF", label: "Fed Funds (Effective)", unit: "%" },
  { id: "DFEDTARU", label: "Fed Funds Target Upper", unit: "%" },
  { id: "DGS2", label: "US 2Y Yield", unit: "%" },
  { id: "DGS10", label: "US 10Y Yield", unit: "%" },
  { id: "DGS30", label: "US 30Y Yield", unit: "%" },
  { id: "DFII10", label: "US 10Y Real Yield", unit: "%" },
  { id: "ECBMRRFR", label: "ECB Main Refi Rate", unit: "%" },
  { id: "ECBDFR", label: "ECB Deposit Facility", unit: "%" },
  { id: "IRLTLT01DEM156N", label: "German 10Y Bund (monthly)", unit: "%" },
];

export async function fetchAllRates(): Promise<FredObservation[]> {
  const results = await Promise.all(
    RATE_SERIES.map((s) => fredLatest(s.id, s.label, s.unit)),
  );
  return results.filter((r): r is FredObservation => r !== null);
}
