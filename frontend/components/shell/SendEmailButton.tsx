"use client";

// Header "Send email" button + modal. Shows what's in the basket, lets the
// user add a personal note + optional recipient, then opens Gmail compose
// pre-filled with all selected items.

import { useState } from "react";
import { Mail, Send, X, ExternalLink, Trash2 } from "lucide-react";
import {
  useEmailBasket,
  buildGmailComposeUrl,
} from "@/providers/EmailBasketProvider";
import { Modal } from "@/components/primitives/Modal";

export function SendEmailButton() {
  const { items, count, remove, clear } = useEmailBasket();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [recipient, setRecipient] = useState("");

  const send = () => {
    const url = buildGmailComposeUrl(items, note, recipient);
    window.open(url, "_blank", "noopener,noreferrer");
    // Clear basket after send so it doesn't linger
    clear();
    setNote("");
    setRecipient("");
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2 rounded-button border border-bd bg-panel px-3 text-[12.5px] text-tx hover:bg-s2"
        title="Send an email with selected news items"
      >
        <Mail size={13} />
        Send email
        {count > 0 ? (
          <span className="ml-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-[6px] text-[10.5px] font-semibold text-white">
            {count}
          </span>
        ) : null}
      </button>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Send email"
        description={
          count === 0
            ? "Nothing in your email basket yet. Add articles by clicking the + icon on news items, then come back."
            : `${count} item${count === 1 ? "" : "s"} queued to share via Gmail.`
        }
        width={620}
        actions={
          <>
            <button
              className="rounded-button px-3 py-[7px] text-[12.5px] text-tx2 hover:text-tx"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            {count > 0 ? (
              <>
                <button
                  onClick={clear}
                  className="inline-flex items-center gap-1 rounded-button border border-bd2 bg-s1 px-3 py-[7px] text-[12.5px] text-tx-mid hover:bg-s2 hover:text-tx"
                >
                  <Trash2 size={12} />
                  Clear basket
                </button>
                <button
                  onClick={send}
                  className="inline-flex items-center gap-2 rounded-button bg-brand px-3 py-[7px] text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(10,37,64,0.08),0_2px_6px_rgba(47,127,255,0.24)] hover:bg-brand-hi"
                >
                  <Send size={12} />
                  Open in Gmail
                </button>
              </>
            ) : null}
          </>
        }
      >
        {count === 0 ? (
          <div className="rounded-panel border border-dashed border-bd bg-panel2 p-6 text-center text-[13px] text-tx-mid">
            The basket is empty. Open <strong className="text-tx">News</strong>{" "}
            or an event's source panel, then click the <strong>+</strong> icon
            next to an article to add it here.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-[12px] text-tx2">
                Recipient (optional)
              </label>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="colleague@example.com"
                className="h-9 w-full rounded-button border border-bd2 bg-s1 px-3 text-[13.5px] text-tx outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
              />
              <p className="mt-1 text-[11px] text-tx3">
                Leave blank to just open a blank compose window.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-[12px] text-tx2">
                Note (optional)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Wow, look at this…"
                className="w-full resize-none rounded-button border border-bd2 bg-s1 p-3 text-[13.5px] text-tx placeholder:text-tx3 outline-none focus:border-brand focus:shadow-[0_0_0_3px_rgba(47,127,255,0.18)]"
              />
            </div>

            <div>
              <div className="mb-1 text-[12px] text-tx2">
                Articles ({count})
              </div>
              <ul className="max-h-[260px] divide-y divide-bd overflow-y-auto rounded-panel border border-bd bg-s1">
                {items.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-start justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-tx">
                        {it.headline}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-tx-mid">
                        <span className="font-medium text-brand-fg">
                          {it.source}
                        </span>
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:text-tx"
                        >
                          preview <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                    <button
                      onClick={() => remove(it.id)}
                      className="text-tx-mid hover:text-danger"
                      title="Remove"
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
