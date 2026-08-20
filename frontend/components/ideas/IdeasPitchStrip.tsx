"use client";

// Ideas pitch strip — renders Feature 3C's AI-drafted pitches above
// the ranking leaderboard on /ideas. Each pitch is a card with
// thesis + rationale + risks + catalyst + source chips. Horizontal
// scroll on narrow viewports, grid on wide.

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  Copy,
  Check,
  Info,
} from "lucide-react";
import type { Ideas, IdeaPitch, IdeaSourceRef } from "@/lib/types";
import { TickerLogo } from "@/components/primitives/TickerLogo";

// Shape a pitch into plain-text form suitable for pasting into
// Slack/email/notes app. Includes the ticker + link back so a
// downstream reader can trace the source.
function formatPitchForClipboard(p: IdeaPitch, siteOrigin: string): string {
  const url = `${siteOrigin}/s/${encodeURIComponent(p.ticker)}`;
  const risks = p.risks.map((r) => `- ${r}`).join("\n");
  const catalyst = p.catalyst.date
    ? `${p.catalyst.label} · ${p.catalyst.date}`
    : p.catalyst.label;
  return [
    `${p.ticker} · rank #${p.rank} · composite ${p.compositeScore >= 0 ? "+" : ""}${p.compositeScore.toFixed(3)}`,
    ``,
    p.thesis,
    ``,
    p.rationale,
    ``,
    `Risks:`,
    risks,
    ``,
    `Catalyst: ${catalyst}`,
    ``,
    `Source: ${url}`,
  ].join("\n");
}

function CopyButton({ pitch }: { pitch: IdeaPitch }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const onClick = async () => {
    try {
      const text = formatPitchForClipboard(pitch, window.location.origin);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2400);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy pitch to clipboard (thesis + rationale + risks + catalyst + link)"
      className="inline-flex h-6 items-center gap-1 rounded-[3px] border border-bd bg-s1 px-[6px] text-[10px] font-mono uppercase tracking-[0.06em] text-tx-mid hover:bg-hover hover:text-tx"
    >
      {copied ? (
        <>
          <Check size={10} className="text-success-fg" /> copied
        </>
      ) : failed ? (
        <>
          <Copy size={10} className="text-danger" /> failed
        </>
      ) : (
        <>
          <Copy size={10} /> copy
        </>
      )}
    </button>
  );
}

function SourceChip({ s }: { s: IdeaSourceRef }) {
  const isUrl = /^https?:\/\//i.test(s.ref);
  const body = (
    <>
      <span className="uppercase tracking-[0.06em]">{s.kind}</span>
      <span aria-hidden className="text-tx3">
        ·
      </span>
      <span className="truncate">{s.ref}</span>
      {isUrl ? (
        <ArrowUpRight aria-hidden className="h-[9px] w-[9px] text-tx3" />
      ) : null}
    </>
  );
  const className =
    "inline-flex max-w-[24ch] items-center gap-1 rounded-[3px] border border-bd bg-s2 px-[6px] py-[1px] font-mono text-[9.5px] text-tx-mid hover:text-tx";
  if (isUrl) {
    return (
      <a
        href={s.ref}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {body}
      </a>
    );
  }
  return <span className={className}>{body}</span>;
}

function PitchCard({ p }: { p: IdeaPitch }) {
  return (
    <article className="flex min-w-[320px] max-w-[420px] flex-1 flex-col rounded-[8px] border border-bd bg-panel p-4 shadow-[0_1px_2px_rgba(10,37,64,0.04)]">
      {/* Header — rank, ticker chip, link to detail, copy action */}
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-tx3">#{p.rank}</span>
          <TickerLogo ticker={p.ticker} name={p.ticker} size={26} />
          <Link
            href={`/s/${encodeURIComponent(p.ticker)}`}
            className="font-mono text-[11.5px] text-brand-fg hover:underline"
          >
            {p.ticker}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton pitch={p} />
          <span className="font-mono text-[10.5px] tabular-nums text-tx-mid">
            {p.compositeScore >= 0 ? "+" : ""}
            {p.compositeScore.toFixed(3)}
          </span>
        </div>
      </header>

      {/* Thesis — the one-liner */}
      <p className="mb-3 text-[14px] font-semibold leading-[1.35] text-tx">
        {p.thesis}
      </p>

      {/* Rationale — 3-5 sentences */}
      <p className="mb-3 text-[12.5px] leading-[1.55] text-tx-mid">
        {p.rationale}
      </p>

      {/* Risks */}
      {p.risks.length > 0 ? (
        <div className="mb-3 rounded-[6px] border border-[rgba(202,138,4,0.32)] bg-[rgba(202,138,4,0.05)] px-2.5 py-1.5">
          <div className="mb-1 flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
            <AlertTriangle aria-hidden className="h-[10px] w-[10px] text-[rgba(202,138,4,1)]" />
            Risks
          </div>
          <ul className="space-y-0.5 text-[11.5px] leading-[1.5] text-tx-mid">
            {p.risks.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Catalyst */}
      <div className="mb-3 flex items-center gap-1.5 font-mono text-[10.5px] text-tx-mid">
        <Calendar aria-hidden className="h-[11px] w-[11px] text-tx3" />
        <span className="uppercase tracking-[0.06em] text-tx3">Catalyst</span>
        <span className="normal-case tracking-normal text-tx">
          {p.catalyst.label}
        </span>
        {p.catalyst.date ? (
          <span className="text-tx3">· {p.catalyst.date}</span>
        ) : null}
      </div>

      {/* Sources */}
      <div className="mt-auto flex flex-wrap gap-1">
        {p.sources.map((s, i) => (
          <SourceChip key={i} s={s} />
        ))}
      </div>
    </article>
  );
}

export function IdeasPitchStrip({ ideas }: { ideas: Ideas }) {
  return (
    <section aria-label="AI pitch strip" className="mb-6">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.08em] text-tx3">
          § AI pitches · {ideas.pitches.length}
        </h2>
        <span className="font-mono text-[10.5px] text-tx3">
          generated {ideas.generatedAt.slice(0, 16).replace("T", " ")}Z
        </span>
      </header>

      <div className="flex flex-wrap gap-3">
        {ideas.pitches.map((p) => (
          <PitchCard key={p.ticker} p={p} />
        ))}
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-[6px] border border-bd bg-panel2/50 px-3 py-2 text-[11.5px] leading-[1.55] text-tx-mid">
        <Info aria-hidden className="mt-[2px] h-[12px] w-[12px] shrink-0 text-tx3" />
        <span>{ideas.disclaimer}</span>
      </div>
    </section>
  );
}
