"use client";

import { useEffect, useRef, useState } from "react";
import { useSourceViewer } from "@/providers/SourceViewerProvider";
import { SlideOver } from "@/components/primitives/SlideOver";
import { ProvenanceChip } from "@/components/primitives/ProvenanceChip";
import { Button } from "@/components/primitives/Button";
import {
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Info,
  Search,
} from "lucide-react";
import {
  ShareEmailButton,
  shareArticleProps,
} from "@/components/primitives/ShareEmailButton";
import { api } from "@/lib/apiClient";
import { urlHash } from "@/lib/itemDedupe";
import { INGESTABLE_HOSTS } from "@/server/lib/documentIngest";
import type { Document } from "@/lib/types";

// Source viewer with three tiers:
//   1. Hosted mode — ingested Document → render sanitized HTML inline,
//      auto-scroll to Fact.source.locator (#para-N or #seg-N)
//   2. Iframe proxy — allowlisted public-info hosts render through
//      /api/documents/proxy inside an iframe
//   3. Link-out — publisher blocks embedding → open at publisher

type DocState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "hit"; doc: Document }
  | { status: "miss" };

export function SourceViewer() {
  const { open, close } = useSourceViewer();
  const [iframeStatus, setIframeStatus] = useState<"loading" | "ok" | "blocked">(
    "loading",
  );
  const [iframeKey, setIframeKey] = useState(0);
  const [doc, setDoc] = useState<DocState>({ status: "idle" });
  const [anchorFound, setAnchorFound] = useState<boolean | null>(null);
  const hostedRef = useRef<HTMLDivElement | null>(null);

  const rawUrl = open?.kind === "item" ? open.item.url : open?.source.url ?? "";
  const label = open?.kind === "item" ? open.item.source : open?.source.label ?? "";
  const provenance =
    open?.kind === "item" ? open.item.provenance : open?.source.provenance;
  const title = open?.kind === "item" ? open.item.headline : "Fact source";
  const locator = open?.kind === "fact" ? open.source.locator : null;

  // Google News redirector URLs (news.google.com/rss/articles/<base64>)
  // don't render in an iframe — Google blocks embedding via
  // X-Frame-Options. If the cron-time resolver silently failed for an
  // item, the shard still has the redirector URL even though the
  // publisher label already reads "Yahoo Finance" / "Reuters" / etc.
  // Resolve at click-time via /api/news/resolve, then feed the final URL
  // to the iframe/proxy pipeline.
  const isGnews = (() => {
    if (!rawUrl.startsWith("http")) return false;
    try { return new URL(rawUrl).host.toLowerCase() === "news.google.com"; }
    catch { return false; }
  })();

  // Google search fallback URL (kind: "fallback" in the shard) — no
  // primary document exists, computeSourceLink emitted a search
  // landing page. Iframing google.com/search throws X-Frame-Options,
  // so short-circuit to a dedicated link-out card instead of a 4s
  // empty pane → mis-labeled BlockedFallback.
  const isSearchFallback = (() => {
    if (!rawUrl.startsWith("http")) return false;
    try {
      const u = new URL(rawUrl);
      return (
        u.host.toLowerCase() === "www.google.com" &&
        u.pathname.startsWith("/search")
      );
    } catch { return false; }
  })();
  const [resolvedUrl, setResolvedUrl] = useState<string>(rawUrl);
  const [gnewsUnresolved, setGnewsUnresolved] = useState<boolean>(false);
  useEffect(() => {
    setResolvedUrl(rawUrl);
    setGnewsUnresolved(false);
    if (!isGnews || !open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/news/resolve?url=${encodeURIComponent(rawUrl)}`,
          { cache: "no-store" },
        );
        if (!r.ok) {
          // Google News uses JS-based redirects now; server-side follow
          // can't unwind them. Flag the URL so the render path skips the
          // iframe attempt (which would show "refused to connect") and
          // routes directly to a "Open at Google News" link-out — the
          // user's browser handles the JS redirect naturally on click.
          if (!cancelled) setGnewsUnresolved(true);
          return;
        }
        const j = (await r.json()) as { resolved?: string; changed?: boolean };
        if (cancelled) return;
        if (j.resolved && j.changed) setResolvedUrl(j.resolved);
        else setGnewsUnresolved(true);
      } catch {
        if (!cancelled) setGnewsUnresolved(true);
      }
    })();
    return () => { cancelled = true; };
  }, [rawUrl, isGnews, open]);
  const url = resolvedUrl;

  const isReal = !!url && url !== "#" && url.startsWith("http");

  // Try hosted mode first on every open.
  useEffect(() => {
    if (!open || !isReal) {
      setDoc({ status: "idle" });
      return;
    }
    setDoc({ status: "loading" });
    let cancelled = false;
    (async () => {
      const id = urlHash(url);
      const d = await api.getDocument(id);
      if (cancelled) return;
      if (d) setDoc({ status: "hit", doc: d });
      else setDoc({ status: "miss" });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, url, isReal]);

  // Auto-scroll to locator after hosted content mounts.
  useEffect(() => {
    if (doc.status !== "hit") {
      setAnchorFound(null);
      return;
    }
    if (!locator) {
      setAnchorFound(null);
      hostedRef.current?.scrollTo({ top: 0 });
      return;
    }
    // Defer to next tick so the innerHTML paint completes.
    requestAnimationFrame(() => {
      const container = hostedRef.current;
      if (!container) return;
      const target = container.querySelector(`#${CSS.escape(locator)}`);
      if (target) {
        (target as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        target.classList.add("hosted-anchor-highlight");
        setAnchorFound(true);
      } else {
        setAnchorFound(false);
      }
    });
  }, [doc, locator]);

  // Iframe reset when the URL changes and hosted mode misses.
  // Timeout budget: 3.5s. If neither onLoad-with-content nor onError
  // fires by then, treat as framing-blocked (X-Frame-Options / CSP
  // frame-ancestors deny; browser sometimes silently blocks without
  // firing either event).
  useEffect(() => {
    if (!open || doc.status !== "miss") return;
    setIframeStatus("loading");
    setIframeKey((k) => k + 1);
    const t = setTimeout(() => {
      setIframeStatus((s) => (s === "loading" ? "blocked" : s));
    }, 3500);
    return () => clearTimeout(t);
  }, [open, url, doc.status]);

  // onLoad handler with rendered-content check. The default onLoad
  // fires even for framing-blocked pages that render an inline error
  // placeholder, or for JS-required SPAs whose body starts empty.
  // Trusting onLoad unconditionally locks us into a blank pane; audit
  // §C flagged this as the ECG/OZK "preview not available" class.
  //
  // Strategy:
  //   · Same-origin (proxy path or same-host): read contentDocument.
  //     Body with < 3 direct children → treat as blocked. The proxy
  //     returns full HTML with dozens of children for legit filings,
  //     so this floor is conservative.
  //   · Cross-origin: contentDocument throws (SecurityError). Modern
  //     browsers don't fire onLoad on X-Frame-blocked cross-origin
  //     pages, so reaching this branch means the frame actually
  //     loaded successfully at the origin. Mark ok.
  const handleIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        const body = doc.body;
        if (!body || body.children.length < 3) {
          setIframeStatus("blocked");
          return;
        }
      }
      setIframeStatus("ok");
    } catch {
      // Cross-origin — SecurityError. Load event fired → real doc.
      setIframeStatus("ok");
    }
  };

  // Single source of truth: any host the server is willing to proxy
  // (INGESTABLE_HOSTS) can be embedded inline. Previously this list
  // was hardcoded shorter here, so globenewswire/prnewswire/businesswire/
  // finance.yahoo primary releases fell through to direct-iframe and
  // got X-Frame-Options-blocked into the "Open at publisher" fallback.
  const shouldProxy = (() => {
    if (!isReal) return false;
    try {
      return INGESTABLE_HOSTS.has(new URL(url).host.toLowerCase());
    } catch {
      return false;
    }
  })();
  const iframeSrc = shouldProxy
    ? `/api/documents/proxy?url=${encodeURIComponent(url)}`
    : url;

  return (
    <SlideOver
      open={!!open}
      onOpenChange={(v) => !v && close()}
      eyebrow={
        doc.status === "hit"
          ? `Hosted · ingestVersion ${doc.doc.meta.ingestVersion}`
          : "Source preview"
      }
      title={title}
      width={860}
      actions={
        isReal ? (
          <>
            <ShareEmailButton
              {...shareArticleProps(title as string, url, label as string)}
              size="sm"
              variant="outline"
              label="Share via Gmail"
            />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-button border border-bd2 bg-s1 px-3 text-[12.5px] text-tx hover:bg-s2"
            >
              <ExternalLink size={12} />
              Open at publisher
            </a>
          </>
        ) : null
      }
    >
      {open ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<ArrowLeft size={12} />}
              onClick={close}
            >
              Back to dashboard
            </Button>
            {provenance ? <ProvenanceChip provenance={provenance} /> : null}
            <span className="text-[11.5px] text-tx-mid">{label}</span>
            {doc.status === "hit" ? (
              <span className="ml-2 font-mono text-[11px] text-tx-mid">
                {doc.doc.meta.kind} · {doc.doc.meta.paragraphCount} ¶
                {doc.doc.meta.segments.length > 0
                  ? ` · ${doc.doc.meta.segments.length} seg`
                  : ""}
              </span>
            ) : null}
          </div>

          {doc.status === "hit" ? (
            <HostedRender
              hostedRef={hostedRef}
              doc={doc.doc}
              anchorFound={anchorFound}
              locator={locator}
            />
          ) : doc.status === "loading" ? (
            <div className="flex flex-1 items-center justify-center rounded-panel border border-bd bg-s1 text-[13px] text-tx-mid">
              <RefreshCw
                size={14}
                className="mr-2 animate-spin motion-reduce:animate-none"
              />
              Checking hosted archive…
            </div>
          ) : isSearchFallback ? (
            <SearchFallbackCard url={url} label={label} />
          ) : gnewsUnresolved ? (
            <GnewsFallback url={url} label={label} />
          ) : isReal ? (
            <div className="relative flex-1 overflow-hidden rounded-panel border border-bd bg-s1">
              {iframeStatus !== "blocked" ? (
                <>
                  <iframe
                    key={iframeKey}
                    src={iframeSrc}
                    title={title}
                    className="h-full min-h-[520px] w-full"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    onLoad={handleIframeLoad}
                    onError={() => setIframeStatus("blocked")}
                  />
                  {iframeStatus === "loading" ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-s1/80 text-[13px] text-tx-mid">
                      <RefreshCw
                        size={14}
                        className="mr-2 animate-spin motion-reduce:animate-none"
                      />
                      Loading preview…
                    </div>
                  ) : null}
                </>
              ) : (
                <BlockedFallback url={url} label={label} />
              )}
            </div>
          ) : (
            <div className="rounded-panel border border-bd bg-s1 p-6 text-[13.5px] text-tx-mid">
              No URL on file for this source.
            </div>
          )}

          <div className="rounded-panel border border-bd bg-panel2 p-3 font-mono text-[11px] text-tx-mid">
            <div className="mono-eyebrow mb-1">URL</div>
            <div className="break-all text-tx-strong">{url}</div>
          </div>
        </div>
      ) : null}
    </SlideOver>
  );
}

function HostedRender({
  hostedRef,
  doc,
  anchorFound,
  locator,
}: {
  hostedRef: React.MutableRefObject<HTMLDivElement | null>;
  doc: Document;
  anchorFound: boolean | null;
  locator: string | null;
}) {
  const jumpTo = (paraId: string | undefined) => {
    if (!paraId) return;
    const container = hostedRef.current;
    if (!container) return;
    const el = container.querySelector(`#${CSS.escape(paraId)}`);
    if (el) {
      (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.remove("hosted-anchor-highlight");
      // force reflow so the animation restarts
      void (el as HTMLElement).offsetWidth;
      el.classList.add("hosted-anchor-highlight");
    }
  };

  const segs = doc.meta.segments;

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-hidden">
      {locator && anchorFound === false ? (
        <div className="flex items-center gap-2 rounded-panel border border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.08)] px-3 py-2 text-[12.5px] text-warning">
          <Info size={13} />
          Locator <code className="font-mono">{locator}</code> not found in
          this document version — showing top of document.
        </div>
      ) : null}
      {segs.length > 1 ? (
        <div className="flex flex-wrap items-center gap-[6px] rounded-panel border border-bd bg-panel2 px-3 py-2">
          <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx3">
            Segments
          </span>
          {segs.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.paragraphIds[0])}
              className="inline-flex h-[22px] items-center gap-[6px] rounded-[5px] border border-bd2 bg-s2 px-[9px] text-[11.5px] text-tx hover:bg-s3"
              title={
                s.speaker
                  ? `${s.speaker} · ${s.role}`
                  : s.role === "prepared"
                  ? "Prepared Remarks"
                  : s.role === "qa"
                  ? "Q&A"
                  : `Segment ${s.id}`
              }
            >
              <span
                className={`h-[6px] w-[6px] rounded-full ${
                  s.role === "prepared"
                    ? "bg-success"
                    : s.role === "qa"
                    ? "bg-brand"
                    : "bg-tx3"
                }`}
              />
              {s.speaker ??
                (s.role === "prepared"
                  ? "Prepared"
                  : s.role === "qa"
                  ? "Q&A"
                  : s.id)}
            </button>
          ))}
        </div>
      ) : null}
      <div
        ref={hostedRef}
        className="hosted-doc flex-1 overflow-auto rounded-panel border border-bd bg-s1 p-6 text-[14px] leading-[1.55] text-tx"
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
    </div>
  );
}

function GnewsFallback({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 p-8 text-center">
      <ExternalLink size={22} className="text-brand-fg" />
      <div className="max-w-[52ch]">
        <div className="text-[15px] font-semibold text-tx">
          Google News hosts this article behind a JS redirect
        </div>
        <p className="mt-2 text-[13px] leading-[1.5] text-tx-mid">
          {label || "This item"} lives on{" "}
          <code>news.google.com</code>, which uses a JavaScript-based
          redirect to the real publisher's page. That redirect can't
          run inside an iframe, so we open it directly instead — click
          the button and Google News will forward you to the actual
          article in a new tab.
        </p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
      >
        <ExternalLink size={13} />
        Open at Google News
      </a>
    </div>
  );
}

function SearchFallbackCard({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 p-8 text-center">
      <Search size={22} className="text-tx-mid" />
      <div className="max-w-[52ch]">
        <div className="text-[15px] font-semibold text-tx">
          Primary filing not on record for this quarter
        </div>
        <p className="mt-2 text-[13px] leading-[1.5] text-tx-mid">
          {label || "This source"} carries a search-fallback link — no direct
          earnings document was matched by the ingest pipeline. Open the
          search below to find the release manually, then paste the URL into
          the admin entry form if you want it captured next run.
        </p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
      >
        <ExternalLink size={13} />
        Open Google search
      </a>
    </div>
  );
}

function BlockedFallback({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle size={22} className="text-warning" />
      <div className="max-w-[48ch]">
        <div className="text-[15px] font-semibold text-tx">
          This publisher blocks embedded previews
        </div>
        <p className="mt-2 text-[13px] leading-[1.5] text-tx-mid">
          {label || "The source"} sends an <code>X-Frame-Options</code> or{" "}
          <code>frame-ancestors</code> header that prevents rendering inside
          Signal. Open it at the publisher — the tab stays open so you can
          come back here.
        </p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-9 items-center gap-2 rounded-button bg-brand px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
      >
        <ExternalLink size={13} />
        Open at publisher
      </a>
    </div>
  );
}
