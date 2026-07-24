// Aggregated market data — commodities, FX, indices, sector ETFs, rates.
// Direct port of backend/reference/news.txt.txt fetchMarketData().

import { yahooQuote, type YahooQuoteSample } from "./yahoo";
import { fetchAllRates, type FredObservation } from "./fred";

const COMMODITIES = [
  { s: "DX-Y.NYB", label: "US Dollar Index", unit: "" },
  { s: "EURUSD=X", label: "EUR/USD", unit: "" },
  { s: "BZ=F", label: "Brent Crude", unit: "USD/bbl" },
  { s: "CL=F", label: "WTI Crude", unit: "USD/bbl" },
  { s: "GC=F", label: "Gold", unit: "USD/oz" },
  { s: "SI=F", label: "Silver", unit: "USD/oz" },
  { s: "HG=F", label: "Copper", unit: "USD/lb" },
  { s: "URA", label: "Uranium ETF (URA)", unit: "" },
  { s: "NG=F", label: "Henry Hub NatGas", unit: "USD/MMBtu" },
  { s: "TIO=F", label: "Iron Ore 62%", unit: "USD/t" },
];

const INDICES = [
  { s: "^GSPC", label: "S&P 500", unit: "" },
  { s: "^NDX", label: "Nasdaq 100", unit: "" },
  { s: "^STOXX50E", label: "Euro Stoxx 50", unit: "" },
  { s: "^N225", label: "Nikkei 225", unit: "" },
  { s: "^HSI", label: "Hang Seng", unit: "" },
  { s: "^VIX", label: "VIX", unit: "" },
];

const SECTOR_ETFS = [
  { s: "XLE", label: "Energy (XLE)", unit: "" },
  { s: "XLU", label: "Utilities (XLU)", unit: "" },
  { s: "XLK", label: "Tech (XLK)", unit: "" },
  { s: "XLB", label: "Materials (XLB)", unit: "" },
  { s: "XLF", label: "Financials (XLF)", unit: "" },
  { s: "GDX", label: "Gold Miners (GDX)", unit: "" },
  { s: "COPX", label: "Copper Miners (COPX)", unit: "" },
  { s: "TAN", label: "Solar (TAN)", unit: "" },
  { s: "XLP", label: "Cons. Staples (XLP)", unit: "" },
  { s: "XLY", label: "Cons. Discretionary (XLY)", unit: "" },
];

export interface MarketDataResponse {
  fetchedAt: string;
  rates: FredObservation[];
  commodities: YahooQuoteSample[];
  indices: YahooQuoteSample[];
  sectorEtfs: YahooQuoteSample[];
}

export async function fetchAllMarketData(): Promise<MarketDataResponse> {
  const [rates, commodities, indices, sectorEtfs] = await Promise.all([
    fetchAllRates(),
    Promise.all(COMMODITIES.map((x) => yahooQuote(x.s, x.label, x.unit))),
    Promise.all(INDICES.map((x) => yahooQuote(x.s, x.label, x.unit))),
    Promise.all(SECTOR_ETFS.map((x) => yahooQuote(x.s, x.label, x.unit))),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    rates,
    commodities: commodities.filter((c): c is YahooQuoteSample => c !== null),
    indices: indices.filter((c): c is YahooQuoteSample => c !== null),
    sectorEtfs: sectorEtfs.filter((c): c is YahooQuoteSample => c !== null),
  };
}
