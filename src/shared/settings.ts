export const OPEN_TABS_STORAGE_KEY = "claudy.openTabs";
export const ACTIVE_TAB_STORAGE_KEY = "claudy.activeTabId";
export const APP_SETTINGS_STORAGE_KEY = "claudy.appSettings";

export type ThemePreference = "dark" | "light";

export interface AppSettings {
  rememberOpenTabs: boolean;
  theme: ThemePreference;
  selectedClaudeInstallation: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  rememberOpenTabs: true,
  theme: "dark",
  selectedClaudeInstallation: null,
};

export function loadAppSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      rememberOpenTabs: typeof parsed.rememberOpenTabs === "boolean"
        ? parsed.rememberOpenTabs
        : DEFAULT_APP_SETTINGS.rememberOpenTabs,
      theme: parsed.theme === "light" ? "light" : DEFAULT_APP_SETTINGS.theme,
      selectedClaudeInstallation: typeof parsed.selectedClaudeInstallation === "string" && parsed.selectedClaudeInstallation.trim()
        ? parsed.selectedClaudeInstallation
        : DEFAULT_APP_SETTINGS.selectedClaudeInstallation,
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function saveAppSettings(next: AppSettings) {
  try {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    if (!next.rememberOpenTabs) {
      window.localStorage.removeItem(OPEN_TABS_STORAGE_KEY);
      window.localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
}
