"use client";

// Preferences form on /settings. Fetches shared-state + entity registry
// on mount, lets the user edit focus tickers / theme chips / subscription
// toggles, PUTs the merged state back. First slice of the Stevie-style
// features roadmap — see plan file.

import { useEffect, useMemo, useState } from "react";
import { X, Check } from "lucide-react";
import { Panel } from "@/components/primitives";
import { api } from "@/lib/apiClient";
import { isDisplayable } from "@/lib/displayFilter";
import type { Entity, Preferences, SharedState } from "@/lib/types";

interface Props {
  initialState: SharedState;
  initialEntities: Entity[];
}

function emptyPrefs(): Preferences {
  return {
    focusTickers: [],
    themes: [],
    subscriptions: {
      newTranscripts: false,
      weekAhead: false,
      ideasDigest: false,
    },
  };
}

// Prefer preferences.themes when present; fall back to top-level themes
// during the schema migration.
function pickThemes(state: SharedState): Preferences["themes"] {
  if (state.preferences?.themes && state.preferences.themes.length > 0) {
    return state.preferences.themes;
  }
  return state.themes ?? [];
}

// Assemble the theme catalog offered to the user by unioning known
// themes on shared-state with a coarse pass over entity.sectorTags.
// Keeps the chip list small; anything the user actively toggles gets
// persisted.
function themeCatalog(state: SharedState, entities: Entity[]): Preferences["themes"] {
  const known = new Map<string, { id: string; label: string; active: boolean }>();
  for (const t of pickThemes(state)) known.set(t.id, t);
  // Add a curated set from the most-common sectorTags. Keeps the panel
  // useful without turning it into a wall of ~200 tag chips.
  const CURATED = [
    "copper", "gold", "silver", "uranium", "lithium",
    "semiconductors", "software", "biotech", "energy", "banks",
  ];
  for (const id of CURATED) {
    if (!known.has(id)) {
      const label = id.charAt(0).toUpperCase() + id.slice(1);
      known.set(id, { id, label, active: false });
    }
  }
  // Optionally include any additional sectorTag that shows up in a
  // large-enough slice of the registry (>= 20 entities).
  const counts = new Map<string, number>();
  for (const e of entities) {
    for (const tag of e.sectorTags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  for (const [id, n] of counts) {
    if (n >= 20 && !known.has(id)) {
      const label = id.charAt(0).toUpperCase() + id.slice(1);
      known.set(id, { id, label, active: false });
    }
  }
  return [...known.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function PreferencesForm({ initialState, initialEntities }: Props) {
  const [prefs, setPrefs] = useState<Preferences>(
    () => initialState.preferences ?? { ...emptyPrefs(), themes: pickThemes(initialState) },
  );
  const [tickerQuery, setTickerQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalog = useMemo(
    () => themeCatalog(initialState, initialEntities),
    [initialState, initialEntities],
  );

  // Search results for the focus-ticker picker. Displayable entities
  // only (matches GlobalSearch behavior — ETFs hidden). Cap results
  // so the dropdown stays compact.
  const results = useMemo(() => {
    const q = tickerQuery.trim().toLowerCase();
    if (q.length < 1) return [] as Entity[];
    const focus = new Set(prefs.focusTickers);
    return initialEntities
      .filter((e) => isDisplayable(e))
      .filter((e) => !focus.has(e.ticker))
      .filter((e) =>
        e.ticker.toLowerCase().includes(q) ||
        e.displayName.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [tickerQuery, initialEntities, prefs.focusTickers]);

  const addFocus = (ticker: string) => {
    if (prefs.focusTickers.includes(ticker)) return;
    setPrefs({ ...prefs, focusTickers: [...prefs.focusTickers, ticker] });
    setTickerQuery("");
  };
  const removeFocus = (ticker: string) => {
    setPrefs({
      ...prefs,
      focusTickers: prefs.focusTickers.filter((t) => t !== ticker),
    });
  };
  const toggleTheme = (id: string) => {
    // Merge into a stable order — reuse catalog ordering so toggling
    // doesn't shuffle rows.
    const active = new Set(
      prefs.themes.filter((t) => t.active).map((t) => t.id),
    );
    if (active.has(id)) active.delete(id);
    else active.add(id);
    const next = catalog.map((t) => ({ ...t, active: active.has(t.id) }));
    setPrefs({ ...prefs, themes: next });
  };
  const toggleSub = (key: keyof Preferences["subscriptions"]) => {
    setPrefs({
      ...prefs,
      subscriptions: {
        ...prefs.subscriptions,
        [key]: !prefs.subscriptions[key],
      },
    });
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next: SharedState = { ...initialState, preferences: prefs };
      const r = await fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { lastCommit: string };
      setSavedAt(j.lastCommit);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Merge catalog + persisted state so the chip list shows even fresh
  // (un-persisted) tags with an off state.
  const displayThemes = useMemo(() => {
    const activeIds = new Set(prefs.themes.filter((t) => t.active).map((t) => t.id));
    return catalog.map((c) => ({ ...c, active: activeIds.has(c.id) }));
  }, [catalog, prefs.themes]);

  return (
    <>
      <Panel eyebrow={`Focus tickers · ${prefs.focusTickers.length} selected`}>
        <p className="mb-3 text-[12.5px] text-tx-mid">
          Prioritized subset within the tracked universe — surfaces at the
          top of the watchlist and gates the upcoming Week Ahead + Ideas
          feeds. Different from the full watchlist (which stays as
          ingest-scope).
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {prefs.focusTickers.length === 0 ? (
            <span className="text-[12.5px] text-tx3">
              None yet — search below to add.
            </span>
          ) : (
            prefs.focusTickers.map((t) => (
              <span
                key={t}
                className="inline-flex h-7 items-center gap-1.5 rounded-button border border-bd bg-s1 pl-2.5 pr-1 font-mono text-[11.5px] text-tx"
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => removeFocus(t)}
                  className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-tx-mid hover:bg-hover hover:text-tx"
                >
                  <X size={11} />
                </button>
              </span>
            ))
          )}
        </div>
        <div className="relative">
          <input
            type="text"
            value={tickerQuery}
            onChange={(e) => setTickerQuery(e.target.value)}
            placeholder="Type a ticker or company name…"
            className="h-9 w-full rounded-button border border-bd bg-s1 px-3 text-[13px] text-tx placeholder:text-tx3 focus:border-brand focus:outline-none"
          />
          {results.length > 0 ? (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-[280px] overflow-y-auto rounded-panel border border-bd bg-s0 shadow-[0_8px_24px_rgba(10,37,64,0.12)]">
              {results.map((e) => (
                <button
                  key={e.ticker}
                  type="button"
                  onClick={() => addFocus(e.ticker)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-hover"
                >
                  <span className="font-mono text-[11px] text-brand-fg">
                    {e.ticker}
                  </span>
                  <span className="truncate text-tx">{e.displayName}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel eyebrow={`Themes · ${displayThemes.filter((t) => t.active).length} active`}>
        <p className="mb-3 text-[12.5px] text-tx-mid">
          Recurring sector interests — chips light up when active. Wired
          into the upcoming Week Ahead + Ideas features.
        </p>
        <div className="flex flex-wrap gap-2">
          {displayThemes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => toggleTheme(t.id)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-button border px-3 text-[12.5px] transition ${
                t.active
                  ? "border-brand bg-[rgba(47,127,255,0.10)] text-brand-fg"
                  : "border-bd bg-s1 text-tx-mid hover:bg-hover"
              }`}
            >
              {t.active ? <Check size={12} /> : null}
              {t.label}
            </button>
          ))}
        </div>
      </Panel>

      <Panel eyebrow="Subscriptions">
        <p className="mb-3 text-[12.5px] text-tx-mid">
          Turn on to have upcoming features push updates. Storage-only
          today — subsequent features will read these flags.
        </p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {(
            [
              {
                key: "newTranscripts" as const,
                label: "New transcripts",
                hint: "Alert when a covered ticker publishes a new call transcript.",
              },
              {
                key: "weekAhead" as const,
                label: "Week Ahead digest",
                hint: "Weekly view of upcoming events on focus tickers + themes.",
              },
              {
                key: "ideasDigest" as const,
                label: "Ideas digest",
                hint: "3×/week ranked signals across the covered universe.",
              },
            ] as const
          ).map((s) => {
            const on = prefs.subscriptions[s.key];
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleSub(s.key)}
                className={`flex flex-col items-start rounded-panel border p-3 text-left transition ${
                  on
                    ? "border-brand bg-[rgba(47,127,255,0.05)]"
                    : "border-bd bg-s1 hover:bg-hover"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-[13px] font-medium text-tx">
                    {s.label}
                  </span>
                  <span
                    className={`rounded-[4px] px-2 py-[1px] font-mono text-[11px] ${
                      on
                        ? "bg-[rgba(18,183,106,0.10)] text-success-fg"
                        : "bg-s3 text-tx-mid"
                    }`}
                  >
                    {on ? "ON" : "OFF"}
                  </span>
                </div>
                <span className="mt-1 text-[11.5px] text-tx-mid">{s.hint}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <div className="flex items-center justify-end gap-3">
        {savedAt ? (
          <span className="text-[12px] text-tx-mid">
            Saved · {new Date(savedAt).toLocaleTimeString()}
          </span>
        ) : null}
        {error ? (
          <span className="text-[12px] text-danger">{error}</span>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </>
  );
}
