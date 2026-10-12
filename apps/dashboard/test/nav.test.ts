import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import { message, translator, type Lang } from "../lib/i18n/core.ts"

const source = readFileSync(new URL("../components/nav.tsx", import.meta.url), "utf8")
const require = createRequire(import.meta.url)
const sections = [
  { key: "nav.workspace", routes: ["/", "/trends", "/logs", "/traces"] },
  { key: "nav.modelInfra", routes: ["/providers", "/models", "/pricing"] },
  { key: "nav.governance", routes: ["/quotas", "/webhooks"] },
  { key: "nav.developer", routes: ["/connect"] },
]
const routes = sections.flatMap(section => section.routes)

// Render the real component; only Next routing and context hooks are substituted.
function render(lang: Lang, pathname: string) {
  const exports: { Nav?: ComponentType } = {}
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(compiled, { exports, require: (id: string) => {
    if (id === "next/link") return { default: "a" }
    if (id === "next/navigation") return { usePathname: () => pathname }
    if (id === "@/lib/i18n/provider") return { useI18n: () => ({ t: translator(lang) }) }
    if (id === "@/lib/i18n/core") return { message }
    if (id === "@/components/theme-provider") return { useTheme: () => ({ preference: "system", setPreference: () => {} }) }
    return require(id)
  } })
  assert.ok(exports.Nav)
  return renderToStaticMarkup(createElement(exports.Nav))
}

for (const lang of ["zh", "en"] as const) {
  test(`navigation renders four named groups and all ten routes in IA order (${lang})`, () => {
    const html = render(lang, "/")
    const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1]
    assert.ok(nav)
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(match => match[1]), routes)
    const groups = [...nav.matchAll(/<div[^>]*class="nav-group"[^>]*>([\s\S]*?)(?=<div[^>]*class="nav-group"|$)/g)]
    assert.equal(groups.length, 4)
    for (const [index, section] of sections.entries()) {
      const group = groups[index]![0]
      assert.match(group, /role="group"/)
      assert.ok(group.includes(`aria-label="${translator(lang)(section.key).replaceAll("&", "&amp;")}"`))
      assert.deepEqual([...group.matchAll(/href="([^"]+)"/g)].map(match => match[1]), section.routes)
    }
    assert.match(html, /<nav[^>]+aria-label="[^"]+"/)
    assert.equal((nav.match(/title="[^"]+"/g) ?? []).length, 10)
    assert.doesNotMatch(nav, /tabindex="-1"|tabindex="[1-9]|nav\.[a-zA-Z]/)
    for (const key of ["nav.usageCosts", "nav.traces", "nav.models", "nav.pricing", "nav.quotas", "nav.connect"]) {
      assert.ok(nav.includes(translator(lang)(key).replaceAll("&", "&amp;")), key)
    }
    if (lang === "en") assert.doesNotMatch(nav, /\p{Script=Han}/u)
  })
}

test("exact and nested routes have one current page; unrelated prefixes have none", () => {
  for (const route of routes) {
    for (const pathname of route === "/" ? [route] : [route, `${route}/detail`]) {
      const html = render("en", pathname)
      const links = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)]
      assert.equal(links.length, 1, pathname)
      assert.ok(links[0]![0].includes(`href="${route}"`), pathname)
    }
  }
  for (const pathname of ["/providers-other", "/logs-other", "/missing"]) {
    assert.doesNotMatch(render("en", pathname), /aria-current="page"/, pathname)
  }
})
