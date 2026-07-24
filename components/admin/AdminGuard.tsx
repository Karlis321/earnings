"use client";

import { useRole } from "@/providers/RoleProvider";
import { Lock } from "lucide-react";

// Editor-only route guard. Client hides admin; live enforcement is server-side (P9).
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isEditor } = useRole();
  if (!isEditor) {
    return (
      <div className="mx-auto max-w-[600px] px-10 py-20 text-center">
        <Lock size={28} className="mx-auto text-warning" />
        <h1 className="mt-4 text-[20px] font-semibold text-tx">
          Admin surfaces are editor-only
        </h1>
        <p className="mt-2 text-[13.5px] text-tx-mid">
          You're currently signed in as read-only. In production this route is
          also blocked server-side.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
