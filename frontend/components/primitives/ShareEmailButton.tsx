"use client";

// Share-via-Gmail button. Opens Gmail's compose window (mail.google.com)
// in a new tab, prefilled with the item's headline + URL + a note.
// Zero server involvement — user hits Send inside their own Gmail session,
// so mail sends literally from eida.karlis@gmail.com.

import { Mail } from "lucide-react";
import clsx from "clsx";

interface Props {
  subject: string;
  body: string;
  className?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "outline";
  label?: string;
}

export function ShareEmailButton({
  subject,
  body,
  className,
  size = "sm",
  variant = "outline",
  label = "Share",
}: Props) {
  const gmailUrl =
    `https://mail.google.com/mail/?view=cm&fs=1` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  const cls =
    variant === "ghost"
      ? "text-tx-mid hover:text-tx"
      : "border border-bd2 bg-s1 text-tx-mid hover:bg-s2 hover:text-tx";
  const sizing =
    size === "md"
      ? "h-9 px-3 text-[13px]"
      : "h-7 px-[10px] text-[11.5px]";

  return (
    <a
      href={gmailUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={clsx(
        "inline-flex items-center gap-[6px] rounded-button transition-colors",
        cls,
        sizing,
        className,
      )}
      title="Share via Gmail — opens compose window"
    >
      <Mail size={size === "md" ? 13 : 11} aria-hidden="true" />
      {label}
    </a>
  );
}

// Convenience helper: build subject + body from a news/source item.
// Defensive against null/undefined headline — a corrupted source item
// (title-field-instead-of-headline was the bug that crashed the event
// page) should never take out the whole render.
export function shareArticleProps(
  headline: string | null | undefined,
  url: string,
  source?: string,
) {
  const safeHeadline = (typeof headline === "string" && headline.length > 0)
    ? headline
    : "(untitled)";
  const subject = `Look at this: ${safeHeadline.slice(0, 100)}`;
  const body =
    `${safeHeadline}\n\n${url}\n\n` +
    (source ? `Source: ${source}\n\n` : "") +
    `— shared from Signal earnings dashboard`;
  return { subject, body };
}
