"use client";

// Component gallery — every primitive in every state on one page.
// P2 exit criterion. Also handy as a live style-guide.

import {
  TypeBadge,
  FreshnessDot,
  SurprisePill,
  GuidanceMoveBadge,
  ProvenanceChip,
  ArticleTypeBadge,
  LanguageBadge,
  ExpectationTag,
  SourceUnavailableChip,
  FactPopover,
  DeepLinkButton,
  Button,
  Input,
  Label,
  FieldHint,
  Card,
  CardBody,
  Panel,
  LoadingSkeleton,
  EmptyState,
  ErrorState,
  StalenessLegend,
  ReactionChart,
  MetricRow,
  MetricRowHeader,
  GuidanceTimeline,
  CatalystCard,
  SourceItemCard,
  DistributionsTable,
  HoldingsTable,
  SlideOver,
  Modal,
} from "@/components/primitives";
import { EARNINGS_FIXTURE } from "@/lib/fixtures/earnings";
import { ETF_DETAILS } from "@/lib/fixtures/etf";
import { GOOGLE_SEARCH_FIXTURE_ITEM } from "@/lib/fixtures/viewerFixtures";
import { useState } from "react";

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <div className="mono-eyebrow mb-3">{eyebrow}</div>
      <h2 className="mb-6 text-[22px] font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function GalleryPage() {
  const [slide, setSlide] = useState(false);
  const [modal, setModal] = useState(false);
  const intel = EARNINGS_FIXTURE.events[0];
  const catalyst = EARNINGS_FIXTURE.events.find((e) => e.kind === "catalyst")!;
  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-10">
        <div className="mono-eyebrow mb-3">§ Gallery · every state on one page</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Component gallery
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] text-tx2">
          Signal primitives from the Design_system spec. Everything renders from
          fixtures — a visual QA surface.
        </p>
      </div>

      <Section eyebrow="§ 09 · Signals" title="Badges">
        <div className="flex flex-wrap gap-3">
          <TypeBadge type="operating" />
          <TypeBadge type="developer" />
          <TypeBadge type="etf" />
          <TypeBadge type="operating" size="sm" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SurprisePill surprisePct={11.6} />
          <SurprisePill surprisePct={-4.2} />
          <SurprisePill surprisePct={0.1} />
          <SurprisePill surprisePct={null} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <GuidanceMoveBadge move="raised" />
          <GuidanceMoveBadge move="held" />
          <GuidanceMoveBadge move="cut" />
          <GuidanceMoveBadge move="initiated" />
          <GuidanceMoveBadge move="withdrawn" />
          <GuidanceMoveBadge move={null} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <ProvenanceChip provenance="regulatory" />
          <ProvenanceChip provenance="ir-page" />
          <ProvenanceChip provenance="wire" />
          <ProvenanceChip provenance="news" />
          <ProvenanceChip provenance="social" />
          <ProvenanceChip provenance="independent" />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <ArticleTypeBadge type="news" />
          <ArticleTypeBadge type="opinion" />
          <LanguageBadge lang="pt" />
          <LanguageBadge lang="fi" />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <ExpectationTag expectation="below" />
          <ExpectationTag expectation="inline" />
          <ExpectationTag expectation="above" />
          <ExpectationTag expectation="unset" />
        </div>
        <div className="mt-4">
          <SourceUnavailableChip
            engine="twitter"
            reason="proxy down"
            lastGood="2026-07-24T05:41:00Z"
          />
        </div>
      </Section>

      <Section eyebrow="§ freshness" title="Freshness dot · RAG">
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center gap-3">
            <FreshnessDot state="fresh" asOf="2026-07-24" />
            Fresh
          </div>
          <div className="flex items-center gap-3">
            <FreshnessDot state="overdue" asOf="2026-07-20" />
            Overdue
          </div>
          <div className="flex items-center gap-3">
            <FreshnessDot state="stale" asOf="2026-07-01" />
            Stale
          </div>
          <div className="flex items-center gap-3">
            <FreshnessDot state="never" />
            Never fetched
          </div>
          <StalenessLegend />
        </div>
      </Section>

      <Section eyebrow="§ 05 · Buttons" title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg">Large · 44</Button>
          <Button>Default · 36</Button>
          <Button size="sm">Compact · 30</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="icon" aria-label="Refresh">
            ↻
          </Button>
          <Button loading>Saving…</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section eyebrow="§ 06 · Forms" title="Inputs">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label required>Display name</Label>
            <Input defaultValue="Intel Corporation" />
          </div>
          <div>
            <Label>Ticker</Label>
            <Input mono defaultValue="INTC US" />
            <FieldHint>Bloomberg-style ticker</FieldHint>
          </div>
          <div>
            <Label>Invalid state</Label>
            <Input invalid defaultValue="not enough" />
          </div>
          <div>
            <Label>Focused</Label>
            <Input autoFocus />
          </div>
        </div>
      </Section>

      <Section eyebrow="§ 07 · Cards" title="Facts & cards">
        <div className="grid grid-cols-[1.4fr_1fr] gap-4">
          <Card eyebrow={`Latest print · ${intel.period}`}>
            <MetricRowHeader />
            {intel.metrics.map((m) => (
              <MetricRow key={m.key} metric={m} />
            ))}
          </Card>
          <div className="flex flex-col gap-4">
            <SourceItemCard item={intel.sources.items[0]} />
            {/* FIXTURE-ONLY — used by scripts/audits/viewer-source-check.mjs
                to runtime-prove the SearchFallbackCard code path. The item's
                url is a google.com/search link, which trips isSearchFallback
                in SourceViewer.tsx (line 73) and routes to SearchFallbackCard
                without ever mounting an iframe. Not real data. */}
            <div
              data-testid="viewer-fixture-google-search"
              className="rounded-panel border border-dashed border-bd bg-s1/60 p-4"
            >
              <div className="mono-eyebrow mb-2 text-tx3">
                Fixture · google-search item (audit-only)
              </div>
              <SourceItemCard item={GOOGLE_SEARCH_FIXTURE_ITEM} />
            </div>
            <div className="rounded-panel border border-bd2 bg-s2 p-4 shadow-[var(--sh-popover)]">
              <div className="mono-eyebrow mb-3">Fact popover · inline demo</div>
              <FactPopover
                fact={intel.metrics[0].estimate}
                displayValue="14.4B"
              >
                <span className="rounded-[6px] border border-bd2 bg-s3 px-3 py-1 font-mono text-[13px] text-tx">
                  Hover / click →
                </span>
              </FactPopover>
              <div className="mt-3">
                <DeepLinkButton
                  source={{
                    url: "https://intel.example/press-q2-2026",
                    label: "Intel Q2 press release · para 4",
                    provenance: "ir-page",
                    locator: "para-4",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section eyebrow="§ guidance & reaction" title="Timelines">
        <div className="grid grid-cols-2 gap-4">
          <Panel eyebrow="Guidance timeline" padded={false}>
            <GuidanceTimeline items={intel.guidance} />
          </Panel>
          <Panel eyebrow="Reaction · 4-horizon">
            <ReactionChart
              points={intel.reaction.points}
              benchmark={intel.reaction.benchmark}
            />
          </Panel>
        </div>
      </Section>

      <Section eyebrow="§ catalysts" title="Developer catalyst card">
        <div className="max-w-[520px]">
          {catalyst.catalysts?.[0] ? (
            <CatalystCard catalyst={catalyst.catalysts[0]} />
          ) : null}
        </div>
      </Section>

      <Section eyebrow="§ etf" title="ETF panels">
        <div className="grid grid-cols-2 gap-4">
          <Panel eyebrow="Distributions" padded={false}>
            <DistributionsTable
              distributions={ETF_DETAILS["GDXJ US"].distributions}
            />
          </Panel>
          <Panel eyebrow="Top holdings" padded={false}>
            <HoldingsTable holdings={ETF_DETAILS["GDXJ US"].holdings} />
          </Panel>
        </div>
      </Section>

      <Section eyebrow="§ states" title="Loading / empty / error">
        <div className="grid grid-cols-3 gap-4">
          <Panel eyebrow="Loading">
            <LoadingSkeleton rows={5} />
          </Panel>
          <div>
            <EmptyState
              title="No sources yet"
              hint="Window still accruing — items will appear as the cron polls."
            />
          </div>
          <div>
            <ErrorState
              title="Something went wrong"
              hint="Retry or check the data status panel."
            />
          </div>
        </div>
      </Section>

      <Section eyebrow="§ overlays" title="SlideOver & Modal">
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setSlide(true)}>
            Open slide-over
          </Button>
          <Button variant="secondary" onClick={() => setModal(true)}>
            Open modal
          </Button>
        </div>
        <SlideOver
          open={slide}
          onOpenChange={setSlide}
          eyebrow="Sample slide-over"
          title="Slide-over pattern"
        >
          <p className="text-[13.5px] leading-[1.6] text-tx-strong">
            Used by the source viewer and admin drawers.
          </p>
        </SlideOver>
        <Modal
          open={modal}
          onOpenChange={setModal}
          title="Confirmation dialog"
          description="Two-line description of the action about to happen."
          actions={
            <>
              <Button variant="ghost" onClick={() => setModal(false)}>
                Cancel
              </Button>
              <Button onClick={() => setModal(false)}>Confirm</Button>
            </>
          }
        >
          Body content goes here.
        </Modal>
      </Section>
    </div>
  );
}
