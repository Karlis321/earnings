"use client";

import type { Entity, EventRecord, Freshness } from "@/lib/types";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { SecuritySwitcher } from "@/components/shell/SecuritySwitcher";
import { FreshnessDot, Button } from "@/components/primitives";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import Link from "next/link";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { daysUntil } from "@/lib/freshness";
import { Pencil, FileText, ExternalLink } from "lucide-react";

interface Props {
  entity: Entity;
  latest?: EventRecord;
  nextEvent?: EventRecord;
  freshness: Freshness;
}

export function SecurityHeader({ entity, latest, nextEvent, freshness }: Props) {
  // "Latest earnings release" = the primary IR press-release URL for the latest event.
  const releaseUrl = latest?.metrics
    .find((m) => m.actual?.source?.url)
    ?.actual?.source?.url;

  return (
    <header className="mb-8">
      <div className="mb-5 flex items-center justify-between gap-4">
        <Breadcrumb
          crumbs={[
            { label: "Overview", href: "/" },
            { label: `${entity.displayName} · ${entity.ticker}` },
          ]}
        />
        <SecuritySwitcher currentTicker={entity.ticker} />
      </div>

      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <TickerLogo
            ticker={entity.ticker}
            name={entity.displayName}
            size={56}
          />
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
                {entity.displayName}
              </h1>
              <span className="font-mono text-[13.5px] text-tx-mid">
                {entity.ticker}
              </span>
              <FreshnessDot state={freshness} />
              {(entity.index_membership ?? []).includes("SP500") ? (
                <Link
                  href="/sectors/sp500"
                  className="inline-flex h-[20px] items-center rounded-[4px] border border-brand/40 bg-brand/10 px-[7px] font-mono text-[10.5px] font-medium text-brand-fg hover:bg-brand/20"
                  title="S&P 500 constituent — click for the grouping view"
                >
                  S&amp;P 500
                </Link>
              ) : null}
              {(entity.index_membership ?? []).includes("R1000") &&
              !(entity.index_membership ?? []).includes("SP500") ? (
                <Link
                  href="/sectors/russell1000"
                  className="inline-flex h-[20px] items-center rounded-[4px] border border-bd2 bg-s3 px-[7px] font-mono text-[10.5px] font-medium text-tx2 hover:bg-s2 hover:text-tx"
                  title="Russell 1000 constituent (non-SP500) — click for the grouping view"
                >
                  R1000
                </Link>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-tx-mid">
              <span>
                <span className="font-mono text-tx3">Listing</span>{" "}
                <span className="text-tx">{entity.listing}</span>
              </span>
              <span>
                <span className="font-mono text-tx3">Benchmark</span>{" "}
                <span className="font-mono text-brand-fg">{entity.benchmark}</span>
              </span>
              <span>
                <span className="font-mono text-tx3">Currency</span>{" "}
                <span className="font-mono text-tx">{entity.currency}</span>
              </span>
              {latest ? (
                <span>
                  <span className="font-mono text-tx3">Last</span>{" "}
                  <span className="text-tx">{latest.period}</span>
                </span>
              ) : null}
              {nextEvent ? (
                <span>
                  <span className="font-mono text-tx3">Next</span>{" "}
                  <span className="text-tx">
                    {fmtDateShort(nextEvent.scheduledDate)}
                  </span>{" "}
                  <span className="text-tx-mid">
                    ·{" "}
                    {/* Use date-only diff (both sides anchored at UTC
                        midnight via ISO parsing) so a same-day
                        scheduled event reads "today", not "1d ago". */}
                    {fmtDaysUntil(daysUntil(nextEvent.scheduledDate))}
                  </span>
                </span>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-[6px]">
              {entity.sectorTags.map((s) => (
                <Link
                  key={s}
                  href={`/sectors/${s}`}
                  className="inline-flex h-[22px] items-center rounded-[5px] border border-bd2 bg-s3 px-[9px] text-[10.5px] text-tx2 hover:text-tx"
                >
                  {s}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {releaseUrl && releaseUrl !== "#" ? (
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-button border border-bd2 bg-s1 px-[14px] text-[13px] font-medium text-tx hover:bg-s2"
            >
              <FileText size={13} />
              Latest earnings release
              <ExternalLink size={11} className="text-tx-mid" />
            </a>
          ) : null}
          <Button variant="secondary" size="md" leadingIcon={<Pencil size={12} />}>
            <Link href={`/admin/securities/${encodeURIComponent(entity.ticker)}`}>
              Edit security
            </Link>
          </Button>
          <Button variant="primary" size="md">
            <Link href={`/admin/entry/${encodeURIComponent(entity.ticker)}`}>
              Manual entry
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
