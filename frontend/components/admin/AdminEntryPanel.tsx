"use client";

// Client wrapper that lifts (eventId, metric, slot) selection state so
// CoverageGrid cell clicks can prefill ManualEntryForm's fields.

import { useRef, useState } from "react";
import type { Entity, EventRecord } from "@/lib/types";
import { CoverageGrid, type CellSelection } from "./CoverageGrid";
import { ManualEntryForm } from "./ManualEntryForm";

export function AdminEntryPanel({
  entity,
  events,
}: {
  entity: Entity;
  events: EventRecord[];
}) {
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <CoverageGrid
        entity={entity}
        events={events}
        onSelect={(sel) => {
          setSelection(sel);
          // Scroll the form into view; the form's autofocus effect grabs
          // the value input for immediate typing.
          requestAnimationFrame(() => {
            formRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          });
        }}
      />
      <div ref={formRef}>
        <ManualEntryForm
          entity={entity}
          events={events}
          selection={selection}
        />
      </div>
    </>
  );
}
