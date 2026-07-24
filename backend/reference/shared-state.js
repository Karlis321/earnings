// /api/shared-state
//
// Shared analyst-curated state — watchlist + custom sources — persisted
// in the repo at data/shared-state.json. GET reads from the on-disk
// version baked into the Vercel deploy; PUT commits to the file via the
// GitHub Contents API using a Personal Access Token, so updates land in
// git history (one commit per save). The next Vercel deploy picks up
// the new file and serves it from disk.
//
// Why a GitHub-commit pipe instead of a KV store
// ==============================================
// The project's strict $0 constraint rules out paid storage. The repo
// is already the persistence layer for data/tweets.json (X scraper
// snapshot) so adding shared-state.json reuses the same pattern —
// no new dashboard, no new service, full audit trail in git.
//
// Trade-off: each write triggers a GitHub commit + Vercel redeploy
// (~1 minute end-to-end before the new file is served by GET). For a
// small team editing rarely, this is acceptable. The client treats
// localStorage as the immediate source of truth and merges from the
// server on app mount, so the user never waits.
//
// Setup steps for the user
// ========================
//  1. Create a fine-grained Personal Access Token on GitHub:
//       Settings → Developer settings → Personal access tokens →
//       Fine-grained tokens → "Generate new token".
//     Scope: Contents = Read & Write on this repository only.
//  2. Add it to Vercel as the env var `GH_PAT` (Project → Settings →
//     Environment Variables → Production + Preview + Development).
//  3. Redeploy. Without the env var, PUT returns 503 and the app
//     gracefully falls back to localStorage-only behavior (no sharing).
//
// Endpoints
// =========
//   GET  /api/shared-state                → 200 { watchlist, customSources }
//   PUT  /api/shared-state                → 200 { watchlist, customSources }
//                                            503 if GH_PAT not configured
//                                            409 on stale-SHA conflict
//                                                (client should retry)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_OWNER = 'tp710-bluor';
const REPO_NAME = 'bluor-news-tracker';
const FILE_PATH = 'data/shared-state.json';
const FILE_BRANCH = 'main';

// On-disk snapshot baked into the deploy. Reload on each handler call
// since the build-time file might be stale by the time another deploy
// is in progress; in practice Vercel keeps the function warm and this
// stays cached between invocations.
function readDiskState() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', 'data', 'shared-state.json');
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { watchlist: [], customSources: [] };
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const state = readDiskState();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      watchlist: Array.isArray(state.watchlist) ? state.watchlist : [],
      customSources: Array.isArray(state.customSources) ? state.customSources : [],
      themes: Array.isArray(state.themes) ? state.themes : [],
    });
  }

  if (req.method === 'PUT') {
    const token = process.env.GH_PAT;
    if (!token) {
      return res.status(503).json({
        error:
          'Shared-state writes require the GH_PAT environment variable. ' +
          'See api/shared-state.js header for setup steps. The app keeps ' +
          'working in localStorage-only mode until this is configured.',
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const next = {
      watchlist: Array.isArray(body.watchlist) ? body.watchlist : [],
      customSources: Array.isArray(body.customSources) ? body.customSources : [],
      themes: Array.isArray(body.themes) ? body.themes : [],
    };

    const newContent = JSON.stringify(next, null, 2) + '\n';

    try {
      // Fetch the current file SHA from GitHub. Required for the PUT
      // so GitHub can detect concurrent edits (optimistic concurrency).
      const ghHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'BluOrNewsTracker/shared-state',
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
      // GET returning 404 is fine: file doesn't exist yet, create on PUT.

      const commitBody = {
        message: 'Update shared state (watchlist / custom sources)',
        // GitHub expects base64-encoded content. Use a Node-safe encoder
        // (Buffer is always available in Vercel functions).
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
        // Stale SHA — another writer beat us. Client should refresh and retry.
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

      return res.status(200).json(next);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Unknown error' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
