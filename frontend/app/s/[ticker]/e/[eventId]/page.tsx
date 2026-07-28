import { notFound } from "next/navigation";
import { store } from "@/server/store";
import { findEntity } from "@/server/lib/registryHelpers";
import { Breadcrumb } from "@/components/shell/Breadcrumb";
import {
  Card,
  MetricRow,
  MetricRowHeader,
  GuidanceTimeline,
  ReactionChart,
  Panel,
  CatalystCard,
  FreshnessDot,
  SurprisePill,
  GuidanceMoveBadge,
} from "@/components/primitives";
import { TickerLogo } from "@/components/primitives/TickerLogo";
import { SourcesPanel } from "@/components/event/SourcesPanel";
import { VerdictNote } from "@/components/event/VerdictNote";
import { computeFreshness } from "@/lib/freshness";
import { fmtDate } from "@/lib/format";

interface Props {
  params: Promise<{ ticker: string; eventId: string }>;
}

// Event (Print) Detail. FE PRD §7.6.

export const dynamic = "force-dynamic";

export default async function EventDetailPage({ params }: Props) {
  const { ticker: rawTicker, eventId: rawEventId } = await params;
  const ticker = decodeURIComponent(rawTicker);
  const eventId = decodeURIComponent(rawEventId);
  const [entities, tickerEvents] = await Promise.all([
    store.readRegistry(),
    store.readEventsForTicker
      ? store.readEventsForTicker(ticker)
      : Promise.resolve([]),
  ]);
  const entity = findEntity(entities, ticker);
  const event = tickerEvents.find((e) => e.id === eventId);
  if (!entity || !event) notFound();

  const freshness = computeFreshness(event.sources.capturedAt ?? event.eventDate);
  const isCatalyst = event.kind === "catalyst";
  const headline = event.metrics.find((m) => m.isHeadline);

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-5">
        <Breadcrumb
          crumbs={[
            { label: "Overview", href: "/" },
            {
              label: `${entity.displayName} · ${entity.ticker}`,
              href: `/s/${encodeURIComponent(entity.ticker)}`,
            },
            { label: event.period },
          ]}
        />
      </div>

      <header className="mb-8 flex items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <TickerLogo
            ticker={entity.ticker}
            name={entity.displayName}
            size={48}
          />
          <div>
          <div className="mb-3 mono-caption normal-case">
              {isCatalyst ? "Catalyst" : "Earnings"} ·{" "}
              {event.timing ?? "unscheduled"} · {fmtDate(event.eventDate ?? event.scheduledDate)}
          </div>
          <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em]">
            {event.period}
            {headline ? (
              <span className="ml-3 align-middle text-[16px] font-normal">
                <SurprisePill
                  surprisePct={headline.surprisePct}
                  hasActual={headline.actual?.value != null}
                />
              </span>
            ) : null}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-tx-mid">
            <span>
              <span className="font-mono text-tx3">Ticker</span>{" "}
              <span className="font-mono text-brand-fg">{entity.ticker}</span>
            </span>
            <span>
              <span className="font-mono text-tx3">Freshness</span>{" "}
              <FreshnessDot state={freshness} />
            </span>
            {event.guidanceMove ? (
              <span>
                <span className="font-mono text-tx3">Guidance</span>{" "}
                <GuidanceMoveBadge move={event.guidanceMove} />
              </span>
            ) : null}
          </div>
          </div>
        </div>
      </header>

      <div className="mb-6">
        <VerdictNote
          eventId={event.id}
          initial={
            typeof event.verdictNote === "string"
              ? event.verdictNote
              : event.verdictNote?.text
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Numbers panel */}
        {isCatalyst ? (
          <Panel eyebrow="Catalyst detail">
            {event.catalysts?.length ? (
              <div className="flex flex-col gap-3">
                {event.catalysts.map((c, i) => (
                  <CatalystCard key={i} catalyst={c} />
                ))}
              </div>
            ) : (
              <div className="text-[13px] text-tx-mid">
                Catalyst detail not yet on file.
              </div>
            )}
          </Panel>
        ) : (
          <Card eyebrow={`Numbers · ${event.period}`}>
            <MetricRowHeader />
            {event.metrics.map((m) => (
              <MetricRow key={m.key} metric={m} />
            ))}
          </Card>
        )}

        <Panel eyebrow="Reaction">
          <ReactionChart
            points={event.reaction.points}
            benchmark={event.reaction.benchmark}
          />
          <div className="mt-4 flex items-center gap-4 font-mono text-[11.5px] text-tx-mid">
            <span>
              baseline{" "}
              <span className="text-tx">
                {event.reaction.baselineDate ?? "—"}
              </span>
            </span>
            <span>
              close{" "}
              <span className="text-tx">
                {event.reaction.baselineClose?.toFixed(2) ?? "—"}
              </span>
            </span>
            <span>
              timing <span className="text-tx">{event.timing ?? "—"}</span>
              <span className="text-tx3">
                {" "}
                · baseline follows{" "}
                {event.timing === "AMC"
                  ? "next session"
                  : event.timing === "BMO"
                  ? "event-day close"
                  : "—"}
              </span>
            </span>
          </div>
        </Panel>

        {!isCatalyst && event.guidance.length > 0 && (
          <Panel eyebrow="Guidance timeline" padded={false}>
            <GuidanceTimeline items={event.guidance} />
          </Panel>
        )}

        <div className="lg:col-span-2">
          <SourcesPanel event={event} />
        </div>
      </div>
    </div>
  );
}
