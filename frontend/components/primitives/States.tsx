import clsx from "clsx";
import { AlertTriangle, InboxIcon } from "lucide-react";

export function LoadingSkeleton({
  rows = 6,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={clsx("space-y-2", className)} aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-button bg-s2"
          style={{ animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-panel border border-dashed border-bd bg-panel px-6 py-12 text-center">
      <div className="text-tx3">{icon ?? <InboxIcon size={24} />}</div>
      <div className="text-[14px] font-medium text-tx-strong">{title}</div>
      {hint ? (
        <div className="max-w-[46ch] text-[12.5px] text-tx-mid">{hint}</div>
      ) : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-panel border border-[rgba(248,113,113,0.24)] bg-[rgba(248,113,113,0.05)] px-6 py-12 text-center">
      <AlertTriangle className="text-danger" size={22} />
      <div className="text-[14px] font-medium text-tx-strong">{title}</div>
      {hint ? (
        <div className="max-w-[46ch] text-[12.5px] text-tx-mid">{hint}</div>
      ) : null}
      {action}
    </div>
  );
}
