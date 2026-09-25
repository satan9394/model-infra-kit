import assert from "node:assert/strict"
import test from "node:test"
import { normalizeThemePreference, resolvesToDarkTheme } from "../lib/theme.ts"

test("theme preference accepts the three supported modes and defaults unknown values to system", () => {
  assert.equal(normalizeThemePreference("light"), "light")
  assert.equal(normalizeThemePreference("dark"), "dark")
  assert.equal(normalizeThemePreference("system"), "system")
  assert.equal(normalizeThemePreference("unexpected"), "system")
  assert.equal(normalizeThemePreference(null), "system")
})

test("system theme follows the current operating system preference", () => {
  assert.equal(resolvesToDarkTheme("light", true), false)
  assert.equal(resolvesToDarkTheme("dark", false), true)
  assert.equal(resolvesToDarkTheme("system", false), false)
  assert.equal(resolvesToDarkTheme("system", true), true)
})
