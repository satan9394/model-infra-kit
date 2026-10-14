import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import ts from "typescript"

/** Transpile the client component so its pure helpers can run under `node --test`. */
function loadFocusTrap(): { trapTargetIndex: (current: number, count: number, shift: boolean) => number | null; FOCUSABLE_SELECTOR: string } {
  const source = readFileSync(new URL("../components/focus-trap.tsx", import.meta.url), "utf8")
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports: Record<string, unknown> = {}
  const require = createRequire(import.meta.url)
  runInNewContext(code, {
    exports,
    require: (id: string) =>
      id === "react" ? { useEffect: () => {}, useRef: (value: unknown) => ({ current: value }) } : require(id),
  })
  return exports as { trapTargetIndex: (current: number, count: number, shift: boolean) => number | null; FOCUSABLE_SELECTOR: string }
}

test("Tab wrap-around covers empty, single, first, last and middle positions", () => {
  const { trapTargetIndex } = loadFocusTrap()
  assert.equal(trapTargetIndex(0, 0, false), null)
  assert.equal(trapTargetIndex(0, 0, true), null)
  // Focus is outside the layer: enter at the appropriate end.
  assert.equal(trapTargetIndex(-1, 3, false), 0)
  assert.equal(trapTargetIndex(-1, 3, true), 2)
  // Wrap with a single focusable element goes back to that element.
  assert.equal(trapTargetIndex(0, 1, false), 0)
  assert.equal(trapTargetIndex(0, 1, true), 0)
  // Forwards from the last wraps to the first; backwards from the first wraps to the last.
  assert.equal(trapTargetIndex(2, 3, false), 0)
  assert.equal(trapTargetIndex(0, 3, true), 2)
  // Interior positions are left to the browser.
  assert.equal(trapTargetIndex(1, 3, false), null)
  assert.equal(trapTargetIndex(1, 3, true), null)
  assert.equal(trapTargetIndex(2, 3, true), null)
})

test("the focus trap exposes a real selector and restores focus to the trigger", () => {
  const { FOCUSABLE_SELECTOR } = loadFocusTrap()
  assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/)
  assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex="-1"\]\)/)

  const source = readFileSync(new URL("../components/focus-trap.tsx", import.meta.url), "utf8")
  assert.match(source, /event\.key === "Escape"/)
  assert.match(source, /event\.key !== "Tab"/)
  assert.match(source, /removeEventListener\("keydown"/)
  assert.match(source, /trigger\?\.focus\(\)/)
  // The trap must not steal an intentional `autofocus` inside the layer.
  assert.match(source, /container\.contains\(document\.activeElement\)/)
})

test("the drawers and the playground trap focus and announce their expanded state", () => {
  const logs = readFileSync(new URL("../components/logs-client.tsx", import.meta.url), "utf8")
  assert.match(logs, /useFocusTrap\(trapRef, true, onClose\)/)
  assert.match(logs, /ref=\{trapRef\}/)
  assert.match(logs, /aria-haspopup="dialog"/)
  assert.match(logs, /aria-expanded=\{openId === event\.requestId\}/)

  const playground = readFileSync(new URL("../components/playground-drawer.tsx", import.meta.url), "utf8")
  assert.match(playground, /useFocusTrap\(trapRef, true, close\)/)
  assert.match(playground, /ref=\{trapRef\}/)

  const connect = readFileSync(new URL("../components/connect-generator.tsx", import.meta.url), "utf8")
  assert.match(connect, /aria-expanded=\{playground\}/)
  assert.match(connect, /aria-haspopup="dialog"/)
})

test("the live badge announces SSE state through a visually hidden polite region", () => {
  const live = readFileSync(new URL("../components/live-refresh.tsx", import.meta.url), "utf8")
  assert.match(live, /aria-live="polite"/)
  assert.match(live, /className="sr-only"/)
  assert.match(live, /data-testid="live-announcer"/)
  assert.match(live, /t\("a11y\.liveConnected"\)/)
  assert.match(live, /t\("a11y\.liveDisconnected"\)/)
})

test("reduced-motion is honoured globally and on the drawers", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /transition-duration: 0\.01ms !important/)
  assert.match(css, /animation-duration: 0\.01ms !important/)

  for (const file of ["logs-client", "playground-drawer"]) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8")
    assert.match(source, /motion-reduce:transition-none/, file)
  }
})

test("the embed shell is mounted by the embed layout with the configured allow-list", () => {
  const layout = readFileSync(new URL("../app/embed/layout.tsx", import.meta.url), "utf8")
  assert.match(layout, /parseAllowedOrigins\(process\.env\.MIK_EMBED_ALLOWED_ORIGINS\)/)
  assert.match(layout, /<EmbedShell allowedOrigins=\{allowedOrigins\}>/)
})

test("the new embed and a11y dictionary keys exist in both languages", async () => {
  const { en } = await import("../lib/i18n/en.ts")
  const { zh } = await import("../lib/i18n/zh.ts")
  const keys = ["embed.bridgeReady", "embed.bridgeError", "a11y.liveConnected", "a11y.liveDisconnected"] as const
  for (const key of keys) {
    const zhMessage = (zh as Record<string, string>)[key]
    const enMessage = (en as Record<string, string>)[key]
    assert.ok(zhMessage, `zh.${key}`)
    assert.ok(enMessage, `en.${key}`)
    assert.doesNotMatch(enMessage, /\p{Script=Han}/u, key)
  }
})
