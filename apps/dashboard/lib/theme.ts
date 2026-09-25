export type ThemePreference = "light" | "dark" | "system"

export const THEME_STORAGE_KEY = "mik-dashboard-theme"

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

export function resolvesToDarkTheme(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  return preference === "dark" || (preference === "system" && systemPrefersDark)
}
