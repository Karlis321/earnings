import { LoadingSpinner } from "@/components/primitives/LoadingSpinner";

// Event-print page fetches the same shard as the ticker page then
// finds the matching event id / period. Spinner between click and
// hydration.
export default function EventLoading() {
  return <LoadingSpinner label="Loading event…" size="lg" fullPage />;
}
