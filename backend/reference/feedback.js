// /api/feedback
//
// Durable per-source / per-keyword / per-item feedback log. Mirrors
// the api/shared-state.js GitHub-commit-pipe pattern: GET reads the
// on-disk snapshot baked into the Vercel deploy; PUT commits the new
// state to data/feedback-log.json via the GitHub Contents API. The
// next deploy picks up the file and GET serves it.
//
// Why this exists
// ===============
// Pre-Phase-5 the feedback store in src/feedback.js was localStorage-
// only. That broke two things:
//   1. Multi-device experience — blocking a source on the desktop didn't
//      sync to the laptop.
//   2. The Phase 6 cron aggregator (data/source-stats.json re-tiering)
//      had no durable, server-side feedback signal to read.
//
// This endpoint solves both at zero recurring cost by reusing the
// same GH_PAT mechanism shared-state.js already uses.
//
// Schema (aggregated state, not event log — avoids unbounded growth)
// ==================================================================
//   {
//     "schema": "feedback-log/v1",
//     "lastUpdated": ISO-8601 | null,
//     "sources": {
//       [sourceName]: { signal: 'positive'|'negative', count, updatedAt }
//     },
//     "keywords": {
//       [keywordLower]: { signal, count, updatedAt }
//     },
//     "items": {
//       [url]: { signal, reason, ts }
//     }
//   }
//
// Endpoints
// =========
//   GET  /api/feedback        → 200 { sources, keywords, items }
//   PUT  /api/feedback        → 200 { sources, keywords, items }
//                               503 if GH_PAT not configured
//                               409 on stale-SHA conflict (client should retry)
//
// 503 graceful degradation: when GH_PAT is missing the app keeps
// working in localStorage-only mode (the same fallback shared-state
// provides).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_OWNER = 'tp710-bluor';
const REPO_NAME = 'bluor-news-tracker';
const FILE_PATH = 'data/feedback-log.json';
const FILE_BRANCH = 'main';

function readDiskState() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'data', 'feedback-log.json');
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { sources: {}, keywords: {}, items: {} };
  }
}

function sanitiseObjMap(v) {
  // Accept anything object-shaped; the client is the schema authority
  // for the inner-record shape. Reject scalars / arrays / null so a
  // bug client can't corrupt the file to a non-object top-level key.
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const state = readDiskState();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      sources: sanitiseObjMap(state.sources),
      keywords: sanitiseObjMap(state.keywords),
      items: sanitiseObjMap(state.items),
    });
  }

  if (req.method === 'PUT') {
    const token = process.env.GH_PAT;
    if (!token) {
      return res.status(503).json({
        error:
          'Feedback writes require the GH_PAT environment variable. ' +
          'See api/feedback.js header for setup steps. The app keeps ' +
          'working in localStorage-only mode until this is configured.',
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const next = {
      schema: 'feedback-log/v1',
      lastUpdated: new Date().toISOString(),
      sources: sanitiseObjMap(body.sources),
      keywords: sanitiseObjMap(body.keywords),
      items: sanitiseObjMap(body.items),
    };

    const newContent = JSON.stringify(next, null, 2) + '\n';

    try {
      const ghHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'BluOrNewsTracker/feedback',
      };
      const apiBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
      const getRes = await fetch(`${apiBase}?ref=${FILE_BRANCH}`, {
        headers: ghHeaders,
      });
      let currentSha = null;
      if (getRes.ok) {
        const meta = await getRes.json();
        currentSha = meta?.sha || null;
      } else if (getRes.status !== 404) {
        const detail = await getRes.text().catch(() => '');
        return res.status(502).json({
          error: `GitHub GET failed (${getRes.status})`,
          detail: detail.slice(0, 400),
        });
      }

      const commitBody = {
        message: 'Update feedback log (source/keyword/item signals)',
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        branch: FILE_BRANCH,
        committer: {
          name: 'bluor-tracker-app',
          email: 'app@bluor.local',
        },
      };
      if (currentSha) commitBody.sha = currentSha;

      const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(commitBody),
      });

      if (putRes.status === 409) {
        return res.status(409).json({
          error: 'Conflicting write — please retry',
        });
      }
      if (!putRes.ok) {
        const detail = await putRes.text().catch(() => '');
        return res.status(502).json({
          error: `GitHub PUT failed (${putRes.status})`,
          detail: detail.slice(0, 400),
        });
      }

      return res.status(200).json({
        sources: next.sources,
        keywords: next.keywords,
        items: next.items,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Unknown error' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
