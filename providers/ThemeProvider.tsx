"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// Signal design system supports three themes (dark default, dim, light).
export type Theme = "dark" | "dim" | "light";

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  cycle: () => void;
}

const Ctx = createContext<ThemeCtx>({
  theme: "dark",
  setTheme: () => undefined,
  cycle: () => undefined,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("signal-theme") as Theme | null;
    if (stored && ["dark", "dim", "light"].includes(stored)) {
      setThemeState(stored);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("signal-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const cycle = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "dim" : t === "dim" ? "light" : "dark"));
  }, []);

  return (
    <Ctx.Provider value={{ theme, setTheme, cycle }}>{children}</Ctx.Provider>
  );
}

export function useTheme() {
  return useContext(Ctx);
}
