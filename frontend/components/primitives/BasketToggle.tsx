"use client";

import { Plus, Check } from "lucide-react";
import { useEmailBasket } from "@/providers/EmailBasketProvider";
import clsx from "clsx";

interface Props {
  id: string;
  headline: string;
  url: string;
  source: string;
  size?: "sm" | "md";
}

export function BasketToggle({ id, headline, url, source, size = "sm" }: Props) {
  const { has, toggle } = useEmailBasket();
  const inBasket = has(id);
  const dim = size === "md" ? 14 : 12;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggle({ id, headline, url, source });
      }}
      title={inBasket ? "Remove from email basket" : "Add to email basket"}
      className={clsx(
        "inline-flex items-center justify-center rounded-[5px] border transition-colors",
        size === "md" ? "h-7 w-7" : "h-[22px] w-[22px]",
        inBasket
          ? "border-brand bg-brand text-white hover:bg-brand-hi"
          : "border-bd2 bg-s1 text-tx-mid hover:bg-s2 hover:text-tx",
      )}
      aria-pressed={inBasket}
      aria-label={inBasket ? "In email basket" : "Add to email basket"}
    >
      {inBasket ? <Check size={dim} /> : <Plus size={dim} />}
    </button>
  );
}
