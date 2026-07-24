"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  width = 480,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-panel border border-bd2 bg-s2 shadow-[var(--sh-popover)]"
          style={{ width }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-bd p-5">
            <div>
              <Dialog.Title className="text-[16px] font-semibold text-tx">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-[12.5px] text-tx-mid">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <button
                className="rounded-button border border-bd2 bg-s3 p-2 text-tx-mid hover:text-tx"
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </Dialog.Close>
          </div>
          <div className="p-5">{children}</div>
          {actions ? (
            <div className="flex items-center justify-end gap-2 border-t border-bd bg-panel p-4">
              {actions}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
