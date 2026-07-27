// TwitterAPI.io tweet fetch — optional paid path (~$0.15 / 1k tweets).
// Per DC15 Nitter is dropped for v1 (blocked from Vercel egress; no CF Worker).
// When TWITTERAPI_IO_KEY is unset the engine reports ok=false, itemsFound=0
// and returns []; siblings keep running.

import type { Entity } from "@/lib/types";
import {
  mentionsHolding,
  matchesExclusionAlias,
  tickerSearchTokens,
} from "@/lib/tickerMatch";

const TWAPI = "https://api.twitterapi.io";
const MAX_LIMIT = 75;

export interface TweetItem {
  id: string;
  headline: string;
  url: string;
  handle: string;
  time: string | null;
  engagement: { likes: number; reposts: number; replies: number };
}

export interface TweetsResult {
  ticker: string;
  fetchedAt: string;
  items: TweetItem[];
  engineStatus: {
    engine: "twitter";
    ok: boolean;
    itemsFound: number;
    reason?: string;
  };
}

interface TwapiTweet {
  id?: string;
  text?: string;
  createdAt?: string;
  author?: { userName?: string };
  twitterUrl?: string;
  url?: string;
  likeCount?: number;
  favoriteCount?: number;
  retweetCount?: number;
  replyCount?: number;
}

async function fetchAdvancedSearch(
  tokens: string[],
  key: string,
): Promise<TwapiTweet[]> {
  if (tokens.length === 0) return [];
  const query = tokens
    .map((t) => (t.includes(" ") ? `"${t.replace(/"/g, "")}"` : t))
    .join(" OR ");
  try {
    const r = await fetch(
      `${TWAPI}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
      {
        headers: { "x-api-key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { tweets?: TwapiTweet[] };
    return j?.tweets ?? [];
  } catch {
    return [];
  }
}

function toItem(t: TwapiTweet): TweetItem | null {
  const handle = t.author?.userName ?? "";
  const text = (t.text ?? "").replace(/\s+/g, " ").trim();
  const id = t.id;
  const url =
    t.twitterUrl ?? t.url ?? (handle && id ? `https://x.com/${handle}/status/${id}` : "");
  if (!id || !url || !text) return null;
  return {
    id,
    headline: text.length > 280 ? text.slice(0, 277) + "…" : text,
    url,
    handle,
    time: t.createdAt ? safeIso(t.createdAt) : null,
    engagement: {
      likes: Number(t.likeCount ?? t.favoriteCount ?? 0),
      reposts: Number(t.retweetCount ?? 0),
      replies: Number(t.replyCount ?? 0),
    },
  };
}

function safeIso(s: string): string | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function fetchTweets(entity: Entity): Promise<TweetsResult> {
  const key = process.env.TWITTERAPI_IO_KEY;
  const fetchedAt = new Date().toISOString();
  if (!key) {
    return {
      ticker: entity.ticker,
      fetchedAt,
      items: [],
      engineStatus: {
        engine: "twitter",
        ok: false,
        itemsFound: 0,
        reason: "TWITTERAPI_IO_KEY unset",
      },
    };
  }

  // Split tokens into cashtag-first and name-first queries. Two focused
  // queries outperform one OR'd blob on the FinTwit-vs-name-writer split.
  const all = tickerSearchTokens(entity);
  const cashtags = all.filter((t) => /^\$/.test(t) || /\./.test(t)).slice(0, 5);
  const names = all.filter((t) => !cashtags.includes(t)).slice(0, 5);

  const [cash, name] = await Promise.all([
    fetchAdvancedSearch(cashtags, key),
    fetchAdvancedSearch(names, key),
  ]);

  const byId = new Map<string, TwapiTweet>();
  for (const t of [...cash, ...name]) {
    if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }

  let items = Array.from(byId.values())
    .map(toItem)
    .filter((it): it is TweetItem => it !== null);

  // mentionsHolding + exclusion alias filter — drop unrelated collisions.
  items = items.filter((it) => {
    if (matchesExclusionAlias(it.headline, entity)) return false;
    // Self-account posts pass through (dedup + downstream quality filters
    // handle the corporate-IR-tweet drop separately).
    if (
      entity.cashtag &&
      it.handle.toLowerCase() === entity.cashtag.toLowerCase()
    ) {
      return true;
    }
    return mentionsHolding(it.headline, entity);
  });

  items = items.slice(0, MAX_LIMIT);

  return {
    ticker: entity.ticker,
    fetchedAt,
    items,
    engineStatus: { engine: "twitter", ok: true, itemsFound: items.length },
  };
}
