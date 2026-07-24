// /api/press-releases?ticker=BN+US
//
// Returns OFFICIAL press releases and regulatory filings for a single
// holding. The per-holding registry of feeds lives in _officialSources.js;
// the raw fetch + parse is shared with /api/must-reads via _feedFetcher.js.
//
// This endpoint adds Claude-Haiku enrichment on top of the raw items:
//   - 1-2 sentence summary (using the LLM's knowledge of what each SEC form
//     typically contains, etc.)
//   - English headline (translation for Portuguese CVM items) — folded into
//     the same API call as the summary, so no extra cost vs the existing
//     /api/news enrichment.

import { fetchOfficialSources } from './_feedFetcher.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker : '';
  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker parameter' });
  }

  const fetched = await fetchOfficialSources(ticker);

  if (!fetched.hasSources) {
    return res.status(200).json({
      ticker,
      count: 0,
      items: [],
      fetchedAt: new Date().toISOString(),
      coverage: 'none',
      message: 'No official press-release sources configured for this ticker',
    });
  }

  // Cap before LLM enrichment to keep prompt size and latency bounded.
  let items = fetched.items.slice(0, 60);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && items.length > 0) {
    const enriched = await enrichWithClaude(items, ticker, apiKey);
    const byUrl = new Map(enriched.map((s) => [s.url, s]));
    items = items.map((it) => {
      const e = byUrl.get(it.url);
      if (!e) return it;
      return {
        ...it,
        headline: e.headline || it.headline,
        summary: e.summary || it.summary || '',
      };
    });
  }

  res.setHeader(
    'Cache-Control',
    'public, s-maxage=600, stale-while-revalidate=3600'
  );

  return res.status(200).json({
    ticker,
    count: items.length,
    items,
    fetchedAt: new Date().toISOString(),
    sourcesPolled: fetched.sourcesPolled,
    upstreamErrors: fetched.upstreamErrors,
    coverage: 'configured',
  });
}

async function enrichWithClaude(items, ticker, apiKey) {
  // Enrich the first 30 (most recent) to keep latency in check; older items
  // pass through with the headline they were parsed with.
  const batch = items.slice(0, 30);
  const hasTranslate = batch.some((it) => it.translate);

  const translationInstruction = hasTranslate
    ? `

3. TRANSLATION: For any item flagged "[TRANSLATE: pt-en]" below, translate the
   headline into clear English and write the summary in English. Preserve any
   regulatory-document codes (e.g. "Fato Relevante", "Comunicado ao Mercado")
   in parentheses after the translated headline so users can recognise the type.
   For non-flagged items leave the headline unchanged.`
    : '';

  const prompt = `You are an analyst at BluOr Asset Management. Each item below is an OFFICIAL press release or regulatory filing from a company we hold. For each item:

1. SUMMARY: 1-2 sentences describing what this filing/release likely contains. Use the headline, source, and URL context. If it's an SEC form (8-K, 10-Q, 6-K, 40-F, etc.), use your knowledge of what those forms typically disclose to give useful context. Neutral and factual.

2. ENGLISH HEADLINE: If the original headline is not in English, translate it. Otherwise return the original headline unchanged.${translationInstruction}

Return STRICT JSON only — no markdown fences, no preamble:
[{"url":"...","headline":"...","summary":"..."}]

Ticker: ${ticker}

Items:
${batch
  .map((it, i) => {
    const flag = it.translate ? `[TRANSLATE: ${it.translate}] ` : '';
    return `${i + 1}. ${flag}[${it.source} · ${it.provenance}]
   Headline: ${it.headline}
   ${it.summary ? `Snippet: ${it.summary.slice(0, 200)}\n   ` : ''}URL: ${it.url}`;
  })
  .join('\n\n')}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return batch.map((it) => ({ url: it.url, summary: '', headline: it.headline }));
    const data = await r.json();
    const text = data?.content?.[0]?.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return batch.map((it) => ({ url: it.url, summary: '', headline: it.headline }));
    return parsed.map((p) => ({
      url: p.url,
      headline: typeof p.headline === 'string' ? p.headline : '',
      summary: typeof p.summary === 'string' ? p.summary : '',
    }));
  } catch {
    return batch.map((it) => ({ url: it.url, summary: '', headline: it.headline }));
  }
}
