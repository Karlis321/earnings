"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function SlideOver({
  open,
  onOpenChange,
  title,
  eyebrow,
  actions,
  children,
  width = 640,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  title: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className="fixed right-0 top-0 z-50 h-full overflow-hidden border-l border-bd bg-panel shadow-[var(--sh-popover)] outline-none"
          style={{ width }}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-bd p-5">
              <div>
                {eyebrow ? <div className="mono-eyebrow mb-2">{eyebrow}</div> : null}
                <Dialog.Title className="text-[18px] font-semibold text-tx">
                  {title}
                </Dialog.Title>
              </div>
              <div className="flex items-center gap-2">
                {actions}
                <Dialog.Close asChild>
                  <button
                    className="rounded-button border border-bd2 bg-s2 p-2 text-tx-mid hover:text-tx"
                    aria-label="Close"
                  >
                    <X size={14} />
                  </button>
                </Dialog.Close>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
