"use client"

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { normalizeThemePreference, resolvesToDarkTheme, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme"

type ThemeContextValue = {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(preference: ThemePreference) {
  const root = document.documentElement
  root.dataset.theme = preference
  root.classList.toggle("dark", resolvesToDarkTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches))
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system")

  useEffect(() => {
    let storedValue: string | null = null
    try {
      storedValue = window.localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      // Keep the system preference when browser storage is unavailable.
    }
    const stored = normalizeThemePreference(storedValue)
    setPreferenceState(stored)
    applyTheme(stored)

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const syncSystemTheme = () => {
      const current = normalizeThemePreference(document.documentElement.dataset.theme)
      applyTheme(current)
    }
    media.addEventListener("change", syncSystemTheme)
    return () => media.removeEventListener("change", syncSystemTheme)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // The active page still changes theme when browser storage is unavailable.
    }
    setPreferenceState(next)
    applyTheme(next)
  }, [])

  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used within ThemeProvider")
  return value
}
