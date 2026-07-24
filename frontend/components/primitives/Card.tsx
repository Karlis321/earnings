import clsx from "clsx";

export function Card({
  children,
  className,
  eyebrow,
  actions,
}: {
  children: React.ReactNode;
  className?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "rounded-panel border border-bd bg-s1",
        className,
      )}
    >
      {(eyebrow || actions) && (
        <div className="flex items-center justify-between border-b border-bd px-[18px] py-[14px]">
          {eyebrow ? <div className="mono-eyebrow">{eyebrow}</div> : <span />}
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      )}
      {children}
    </div>
  );
}

export function CardBody({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={clsx(padded && "p-[18px]", className)}>{children}</div>
  );
}

export function Panel({
  children,
  className,
  eyebrow,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  eyebrow?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-panel border border-bd bg-panel",
        padded && "p-[22px]",
        className,
      )}
    >
      {eyebrow ? <div className="mono-eyebrow mb-4">{eyebrow}</div> : null}
      {children}
    </div>
  );
}
