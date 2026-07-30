import { LoadingSpinner } from "@/components/primitives/LoadingSpinner";

// Root-level loading state — Next.js renders this while any RSC page
// under app/ is fetching data. Individual route segments can override
// with their own loading.tsx for a more specific message.
export default function RootLoading() {
  return <LoadingSpinner label="Loading overview…" size="lg" fullPage />;
}
