// /api/ticker-lookup?symbol=AAPL&exchange=US
//
// Resolve a Bloomberg-style (symbol, exchange-suffix) pair into the
// company's full name + exchange display info, via Yahoo Finance's
// unauthenticated search endpoint.
//
// Why this exists
// ===============
// Watchlist entries used to store just the ticker as the "name", so
// /api/news?q=<ticker> would search Google News literally for "AAPL"
// — and crypto/finance sites pin AAPL as a tag next to BTC headlines,
// so the result was a flood of bitcoin news on an Apple search. Storing
// the real company name fixes that: /api/news?q=Apple%20Inc returns
// what an analyst actually wants.
//
// Yahoo's search returns multiple matches for ambiguous symbols ("TOI"
// hits both Topicus on TSX-V and The Oncology Institute on NASDAQ).
// Filtering by exchange picks the right one. The exchange parameter
// uses Bloomberg-style two-letter codes (US, CN, LN, ...) and we map
// internally to the Yahoo `exchange` field values.

// Bloomberg exchange suffix → set of Yahoo `exchange` codes that count
// as that market. Yahoo's codes are stable and pinning to them avoids
// the cosmetic display strings shifting (NASDAQ → NasdaqGS etc.).
const EXCHANGE_MAP = {
  US: ['NMS', 'NYQ', 'ASE', 'NGM', 'NCM', 'PCX', 'NYS', 'OEM', 'OQX', 'BTS'],
  CN: ['TOR', 'VAN', 'CVE', 'NEO', 'CDNX', 'CDX', 'CNX'],
  LN: ['LSE'],
  GR: ['GER', 'FRA', 'BER', 'DUS', 'HAM', 'MUN', 'STU'],
  FP: ['PAR'],
  BB: ['EBR'],
  NA: ['AMS'],
  IM: ['MIL'],
  SM: ['MCE'],
  SS: ['STO'],
  NO: ['OSL'],
  DC: ['CSE'],
  SW: ['SWX', 'EBS', 'VTX'],
  AV: ['VIE'],
  BZ: ['SAO'],
  MM: ['MEX'],
  AU: ['ASX'],
  HK: ['HKG'],
  JP: ['TYO', 'JPX', 'OSE'],
  KS: ['KSC'],
  IN: ['NSI', 'BOM'],
  SP: ['SES'],
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
  const exchange = (typeof req.query.exchange === 'string' && req.query.exchange.trim()) || 'US';
  if (!rawSymbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }
  const symbol = rawSymbol.toUpperCase();
  const isIndex = exchange === 'Index';
  const acceptable = isIndex ? null : EXCHANGE_MAP[exchange.toUpperCase()];
  if (!isIndex && !acceptable) {
    return res.status(400).json({ error: `Unknown exchange code: ${exchange}` });
  }

  try {
    // Yahoo returns indices under the same quote-search endpoint, but
    // their symbols are prefixed with ^ (^GSPC for S&P 500, ^RUT for
    // Russell 2000). Querying without ^ usually still works — Yahoo's
    // fuzzy match links "SPX" → "^GSPC" — but adding ^ is more robust
    // for common index codes. We try the raw symbol first, then ^symbol
    // if the first call returns no INDEX matches.
    const buildUrl = (q) =>
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}` +
      `&quotesCount=10&newsCount=0`;
    const fetchYahoo = async (q) => {
      const r = await fetch(buildUrl(q), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!r.ok) return { ok: false, status: r.status, quotes: [] };
      const data = await r.json();
      return { ok: true, status: 200, quotes: Array.isArray(data?.quotes) ? data.quotes : [] };
    };

    const first = await fetchYahoo(symbol);
    if (!first.ok) return res.status(502).json({ error: `Yahoo returned ${first.status}` });
    let quotes = first.quotes;

    if (isIndex) {
      // Index branch — find a quoteType=INDEX match. Try raw symbol's
      // results first, then re-query with ^symbol if nothing came back.
      let match = quotes.find(
        (q) => q.quoteType === 'INDEX' &&
          (q.symbol === symbol || q.symbol === '^' + symbol)
      );
      if (!match) {
        match = quotes.find((q) => q.quoteType === 'INDEX');
      }
      if (!match) {
        const second = await fetchYahoo('^' + symbol);
        if (second.ok) {
          quotes = second.quotes;
          match = quotes.find(
            (q) => q.quoteType === 'INDEX' &&
              (q.symbol === '^' + symbol || q.symbol === symbol)
          ) || quotes.find((q) => q.quoteType === 'INDEX');
        }
      }
      if (!match) {
        return res.status(404).json({
          error: `No index found for "${symbol}"`,
          searched: quotes.length,
        });
      }
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        symbol,
        exchange: 'Index',
        name: match.longname || match.shortname || symbol,
        yahooSymbol: match.symbol,
        yahooExchange: match.exchange || null,
        exchDisp: match.exchDisp || null,
        // Indices don't have sector/industry — use a synthetic label so
        // the Watchlist row has something useful in the metadata slot.
        sector: 'Index',
        industry: match.exchDisp || 'Equity index',
        onRequestedExchange: true,
      });
    }

    // Equity match on requested exchange first; if none, fall back to the
    // top equity match overall so the caller can decide whether to accept
    // the wrong-exchange-but-right-symbol result.
    const onExchange = quotes.find(
      (q) =>
        q.quoteType === 'EQUITY' &&
        typeof q.exchange === 'string' &&
        acceptable.includes(q.exchange) &&
        (q.symbol === symbol || q.symbol.split('.')[0] === symbol)
    );
    const anyEquity =
      onExchange ||
      quotes.find(
        (q) => q.quoteType === 'EQUITY' && (q.symbol === symbol || q.symbol.startsWith(symbol + '.'))
      );

    if (!anyEquity) {
      return res.status(404).json({
        error: `No equity found for "${symbol}" on ${exchange}`,
        searched: quotes.length,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      symbol,
      exchange,
      name: anyEquity.longname || anyEquity.shortname || symbol,
      yahooSymbol: anyEquity.symbol,
      yahooExchange: anyEquity.exchange,
      exchDisp: anyEquity.exchDisp || null,
      sector: anyEquity.sector || null,
      industry: anyEquity.industry || null,
      onRequestedExchange: !!onExchange,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
