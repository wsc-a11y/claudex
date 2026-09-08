import { create } from "zustand";
import { api } from "@/api/client";
import type { AppSettings, CustomModel } from "@claudex/shared";

interface AppSettingsState {
  settings: AppSettings | null;
  loading: boolean;
  /** Fetch from server. Safe to call multiple times — only the first call hits the network. */
  load: () => Promise<void>;
  /** Merge a partial patch into local state (optimistic) and persist to server. */
  patch: (partial: Partial<AppSettings>) => Promise<void>;
}

export const useAppSettings = create<AppSettingsState>((set, get) => ({
  settings: null,
  loading: false,

  async load() {
    if (get().settings !== null || get().loading) return;
    set({ loading: true });
    try {
      const { settings } = await api.getAppSettings();
      set({ settings, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  async patch(partial) {
    const prev = get().settings;
    // Optimistic merge
    if (prev) {
      set({ settings: { ...prev, ...partial } });
    }
    try {
      const { settings } = await api.updateAppSettings(partial);
      set({ settings });
    } catch {
      // Rollback
      if (prev) set({ settings: prev });
    }
  },
}));

/** Shorthand: get the custom models list (or empty array). */
export function useCustomModels(): CustomModel[] {
  const settings = useAppSettings((s) => s.settings);
  return settings?.customModels ?? [];
}
