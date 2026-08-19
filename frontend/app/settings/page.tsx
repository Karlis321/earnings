import { store } from "@/server/store";
import { PreferencesForm } from "@/components/settings/PreferencesForm";
import { SettingsDiagnostics } from "./SettingsDiagnostics";

// Settings shell — server component that reads the initial shared-state
// + entity registry off the store and hands them to the client form
// (no round-trip needed for first paint). The diagnostics panels live
// in their own client component since they need /api/health polling.

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [state, entities] = await Promise.all([
    store.readSharedState(),
    store.readRegistry(),
  ]);

  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <h1 className="mb-6 text-[28px] font-semibold tracking-[-0.02em]">
        Settings
      </h1>

      <div className="flex flex-col gap-4">
        <PreferencesForm initialState={state} initialEntities={entities} />
        <SettingsDiagnostics />
      </div>
    </div>
  );
}
