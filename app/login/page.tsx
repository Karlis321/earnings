"use client";

// Login view. Sign-in provider is a P9 backend dependency (SSO vs access-code
// undecided per project PRD §M1 NEEDS DECISION). Fixture mode just navigates home.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@/components/primitives";
import { Lock, AlertTriangle } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[420px] flex-col justify-center px-6 py-10">
      <div className="mb-8 flex items-center gap-3">
        <span
          className="h-9 w-9 rounded-[8px]"
          style={{
            background:
              "linear-gradient(150deg, var(--brand-hi), var(--brand-lo))",
          }}
        />
        <div>
          <div className="text-[20px] font-semibold text-tx">Signal</div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-tx3">
            BluOr · Earnings & Catalyst
          </div>
        </div>
      </div>

      <div className="rounded-panel border border-bd bg-s1 p-6">
        <div className="mb-4 flex items-center gap-2 text-warning">
          <Lock size={14} />
          <span className="mono-eyebrow">Fixture mode · real auth pending</span>
        </div>
        <p className="mb-5 text-[13.5px] leading-[1.55] text-tx-mid">
          Internal BluOr users only. Production will use SSO or an access code —
          decision pending (project PRD §M1). Anything entered here just returns
          you to the dashboard.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length < 4) {
              setError("Access code too short");
              return;
            }
            router.push("/");
          }}
          className="flex flex-col gap-3"
        >
          <div>
            <Label>Access code</Label>
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
              placeholder="Enter access code"
              type="password"
            />
            {error ? (
              <div className="mt-1 flex items-center gap-1 text-[11.5px] text-danger">
                <AlertTriangle size={11} /> {error}
              </div>
            ) : null}
          </div>
          <Button type="submit">Sign in</Button>
        </form>
      </div>

      <p className="mt-6 text-center text-[11.5px] text-tx-mid">
        Decision-support tool. Not investment advice.
      </p>
    </div>
  );
}
