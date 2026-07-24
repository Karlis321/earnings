"use client";

// Email basket — items the user has queued up to send in one Gmail message.
// State survives page navs via localStorage. Send opens Gmail compose with
// a subject + body built from all queued items.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface BasketItem {
  id: string;
  headline: string;
  url: string;
  source: string;
}

interface Ctx {
  items: BasketItem[];
  count: number;
  has: (id: string) => boolean;
  add: (item: BasketItem) => void;
  remove: (id: string) => void;
  clear: () => void;
  toggle: (item: BasketItem) => void;
}

const C = createContext<Ctx>({
  items: [],
  count: 0,
  has: () => false,
  add: () => undefined,
  remove: () => undefined,
  clear: () => undefined,
  toggle: () => undefined,
});

const KEY = "signal-email-basket";

export function EmailBasketProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<BasketItem[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setItems(JSON.parse(raw) as BasketItem[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }, [items]);

  const has = useCallback((id: string) => items.some((i) => i.id === id), [items]);

  const add = useCallback((item: BasketItem) => {
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]));
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const toggle = useCallback(
    (item: BasketItem) => {
      setItems((prev) => {
        if (prev.some((i) => i.id === item.id)) {
          return prev.filter((i) => i.id !== item.id);
        }
        return [...prev, item];
      });
    },
    [],
  );

  const value = useMemo<Ctx>(
    () => ({ items, count: items.length, has, add, remove, clear, toggle }),
    [items, has, add, remove, clear, toggle],
  );

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useEmailBasket() {
  return useContext(C);
}

// Build the Gmail compose URL from items + optional note.
export function buildGmailComposeUrl(
  items: BasketItem[],
  note: string,
  recipient = "",
): string {
  const count = items.length;
  const subject =
    count === 1
      ? `Look at this: ${items[0].headline.slice(0, 90)}`
      : `${count} things worth reading`;
  const bodyLines: string[] = [];
  if (note.trim()) {
    bodyLines.push(note.trim(), "");
  }
  for (const it of items) {
    bodyLines.push(`• ${it.headline}`);
    bodyLines.push(`  ${it.url}`);
    bodyLines.push(`  ${it.source}`);
    bodyLines.push("");
  }
  bodyLines.push("— shared from Signal earnings dashboard");
  const body = bodyLines.join("\n");
  return (
    `https://mail.google.com/mail/?view=cm&fs=1` +
    (recipient ? `&to=${encodeURIComponent(recipient)}` : "") +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}
