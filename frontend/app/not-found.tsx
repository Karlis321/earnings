import Link from "next/link";
import type { Metadata } from "next";
import { EmptyState, Button } from "@/components/primitives";

// noindex the 404 page. Next.js's notFound() returns HTTP 200 with
// the not-found body when called from certain dynamic App Router
// Server Components — the framework renders correctly but the status
// code stays 200 (known quirk on Vercel). Setting robots=noindex is
// the SEO-safe mitigation without diving into custom error handling.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[520px] px-10 py-20">
      <EmptyState
        title="404 · Not found"
        hint="That security, event, or sector isn't in the current watchlist. Head back to the overview."
        action={
          <Button variant="secondary">
            <Link href="/">Back to overview</Link>
          </Button>
        }
      />
    </div>
  );
}
