"use client";

import type { Entity, EventRecord, Freshness } from "@/lib/types";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import { SecuritySwitcher } from "@/components/shell/SecuritySwitcher";
import {
  TypeBadge,
  FreshnessDot,
  Button,
} from "@/components/primitives";
import Link from "next/link";
import { useRole } from "@/providers/RoleProvider";
import { fmtDaysUntil, fmtDateShort } from "@/lib/format";
import { Pencil } from "lucide-react";

interface Props {
  entity: Entity;
  latest?: EventRecord;
  nextEvent?: EventRecord;
  freshness: Freshness;
}

export function SecurityHeader({ entity, latest, nextEvent, freshness }: Props) {
  const { isEditor } = useRole();
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
        <div>
          <div className="flex items-center gap-3">
            <TypeBadge type={entity.securityType} />
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
              {entity.displayName}
            </h1>
            <span className="font-mono text-[13.5px] text-tx-mid">
              {entity.ticker}
            </span>
            <FreshnessDot state={freshness} />
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
            {nextEvent ? (
              <span>
                <span className="font-mono text-tx3">Next</span>{" "}
                <span className="text-tx">
                  {fmtDateShort(nextEvent.scheduledDate)}
                </span>{" "}
                <span className="text-tx-mid">
                  ·{" "}
                  {fmtDaysUntil(
                    Math.round(
                      (new Date(nextEvent.scheduledDate).getTime() -
                        new Date("2026-07-24").getTime()) /
                        86400000,
                    ),
                  )}
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

        <div className="flex items-center gap-2">
          {isEditor ? (
            <>
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
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
