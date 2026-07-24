"use client";

// Role stub — P1 uses this to gate admin, P9 replaces it with real auth.
// Backend integration flag: real sign-in / role enforcement is a P9 backend dependency.

import { createContext, useContext, useState } from "react";

export type Role = "editor" | "readonly";

interface RoleCtx {
  role: Role;
  user: { initials: string; email: string };
  toggle: () => void;
  isEditor: boolean;
}

const Ctx = createContext<RoleCtx>({
  role: "editor",
  user: { initials: "AM", email: "toms@bluor" },
  toggle: () => undefined,
  isEditor: true,
});

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<Role>("editor");
  const value: RoleCtx = {
    role,
    user: { initials: "AM", email: "toms@bluor" },
    toggle: () => setRole((r) => (r === "editor" ? "readonly" : "editor")),
    isEditor: role === "editor",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRole() {
  return useContext(Ctx);
}
