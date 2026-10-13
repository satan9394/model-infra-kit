import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { normalizeThemePreference, resolvesToDarkTheme } from "../lib/theme.ts"

test("secondary text retains normal-text contrast on page and card surfaces in each theme", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  function luminance(hex: string) {
    const [r, g, b] = hex.slice(1).match(/../g)!.map(value => {
      const channel = parseInt(value, 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const themes = [...css.matchAll(/--color-background: (#[a-f0-9]{6});([\s\S]*?)--color-subtle: (#[a-f0-9]{6});/g)]
  assert.equal(themes.length, 3, "light, dark and system-dark palettes")
  for (const theme of themes) {
    const foreground = luminance(theme[3]!)
    const surfaces = [theme[1]!, ...[...theme[2]!.matchAll(/--color-(?:surface|surface-muted): (#[a-f0-9]{6});/g)].map(match => match[1]!)]
    for (const surface of surfaces) {
      const background = luminance(surface)
      const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      assert.ok(ratio >= 4.5, `${theme[3]} on ${surface}: ${ratio.toFixed(2)}:1`)
    }
  }
})

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
