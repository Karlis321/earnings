import clsx from "clsx";
import { forwardRef } from "react";

// Signal buttons — 44/36/30 heights, radius 7 default, 8 large, 6 compact.
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "lg" | "md" | "sm";

const V: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi hover:shadow-[0_2px_8px_rgba(47,127,255,0.32)]",
  secondary:
    "bg-s1 text-tx border border-bd2 hover:bg-s2 hover:border-[rgba(10,37,64,0.22)]",
  ghost:
    "bg-transparent text-tx2 hover:bg-s2 hover:text-tx",
  danger:
    "bg-[rgba(180,35,24,0.06)] text-danger border border-[rgba(180,35,24,0.28)] hover:bg-[rgba(180,35,24,0.10)]",
  icon:
    "bg-s1 text-tx2 border border-bd2 hover:bg-s2 hover:text-tx",
};

const S: Record<ButtonSize, string> = {
  lg: "h-11 px-[22px] text-[15px] rounded-[8px]",
  md: "h-9 px-[18px] text-[13.5px] rounded-button",
  sm: "h-[30px] px-[14px] text-[12.5px] rounded-[6px]",
};

interface Props
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", loading, leadingIcon, children, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed disabled:bg-disabled disabled:text-tx-faint disabled:border-transparent",
        V[variant],
        S[size],
        variant === "icon" && "aspect-square px-0",
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <span
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
          aria-hidden="true"
        />
      ) : (
        leadingIcon
      )}
      {children}
    </button>
  );
});
