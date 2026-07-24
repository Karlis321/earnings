import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px]">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-2">
            {c.href && !last ? (
              <Link href={c.href} className="text-brand-hi hover:text-brand-fg">
                {c.label}
              </Link>
            ) : (
              <span className={last ? "text-tx-mid" : "text-tx"}>{c.label}</span>
            )}
            {!last ? (
              <ChevronRight
                size={12}
                className="text-tx-faint"
                aria-hidden="true"
              />
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
