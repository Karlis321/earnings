"use client";

// Source viewer event bus (P2 → P7). Components emit "open source" events;
// the SourceViewer panel listens and renders hosted-anchor or link-out state.

import { createContext, useCallback, useContext, useState } from "react";
import type { FactSource, SourceItem } from "@/lib/types";

export type ViewerPayload =
  | { kind: "fact"; source: FactSource }
  | { kind: "item"; item: SourceItem };

interface Ctx {
  open: ViewerPayload | null;
  openSource: (p: ViewerPayload) => void;
  close: () => void;
}

const SC = createContext<Ctx>({
  open: null,
  openSource: () => undefined,
  close: () => undefined,
});

export function SourceViewerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<ViewerPayload | null>(null);
  const openSource = useCallback((p: ViewerPayload) => setOpen(p), []);
  const close = useCallback(() => setOpen(null), []);
  return (
    <SC.Provider value={{ open, openSource, close }}>{children}</SC.Provider>
  );
}

export function useSourceViewer() {
  return useContext(SC);
}
