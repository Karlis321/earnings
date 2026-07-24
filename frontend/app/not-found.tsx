import Link from "next/link";
import { EmptyState, Button } from "@/components/primitives";

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
