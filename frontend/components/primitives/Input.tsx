import clsx from "clsx";
import { forwardRef } from "react";

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, invalid, mono, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        "h-9 w-full rounded-button border bg-s2 px-3 text-[13.5px] text-tx outline-none placeholder:text-tx3",
        "focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]",
        invalid ? "border-[rgba(248,113,113,0.55)]" : "border-bd2",
        mono && "font-mono",
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  children,
  required,
  hint,
}: {
  children: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <label className="mb-[7px] flex items-center gap-2 text-[12px] text-tx2">
      <span>
        {children}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </span>
      {hint ? (
        <span className="ml-auto font-mono text-[11px] text-tx-faint">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-[11.5px] text-danger" role="alert">
      {children}
    </div>
  );
}

export function FieldHint({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[11.5px] text-tx3">{children}</div>;
}
