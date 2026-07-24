import { AddEditSecurityForm } from "@/components/admin/AddEditSecurityForm";

export default function NewSecurityPage() {
  return (
    <div>
      <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.02em]">
        Add security
      </h1>
      <p className="mb-6 text-[13px] text-tx-mid">
        Register a ticker, assign its type, and set the reaction benchmark.
        Type-dependent fields render conditionally.
      </p>
      <AddEditSecurityForm mode="new" />
    </div>
  );
}
