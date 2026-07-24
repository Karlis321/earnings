"use client";

import { createContext, useCallback, useContext, useState } from "react";

export type ToastKind = "success" | "warning" | "danger" | "info";
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface Ctx {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
}

const C = createContext<Ctx>({
  toasts: [],
  push: () => undefined,
  dismiss: () => undefined,
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2, 8);
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4500);
  }, []);
  const dismiss = useCallback(
    (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );
  return (
    <C.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastViewport />
    </C.Provider>
  );
}

function ToastViewport() {
  const { toasts, dismiss } = useContext(C);
  return (
    <div
      className="pointer-events-none fixed right-6 bottom-6 z-[60] flex w-[320px] flex-col gap-2"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((t) => {
        const border =
          t.kind === "success"
            ? "border-[rgba(52,211,153,0.35)]"
            : t.kind === "warning"
            ? "border-[rgba(251,191,36,0.35)]"
            : t.kind === "danger"
            ? "border-[rgba(248,113,113,0.35)]"
            : "border-bd2";
        const fg =
          t.kind === "success"
            ? "text-success-fg"
            : t.kind === "warning"
            ? "text-warning"
            : t.kind === "danger"
            ? "text-danger"
            : "text-tx";
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-panel border ${border} bg-s2 p-3 shadow-[var(--sh-popover)]`}
            role="status"
          >
            <div className={`mt-[3px] text-[13px] ${fg}`}>{t.message}</div>
            <button
              className="ml-auto text-tx3 hover:text-tx"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function useToast() {
  return useContext(C);
}
