import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import ts from "typescript"

test("row-cell drawer opening focuses its request button before mounting the dialog", () => {
  const calls: string[] = []
  const require = createRequire(import.meta.url)
  const exports: { LogsClient?: (props: unknown) => unknown } = {}
  const source = readFileSync(new URL("../components/logs-client.tsx", import.meta.url), "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { exports, URLSearchParams, require: (id: string) => {
    if (id === "react") return { useState: () => [null, (id: string) => calls.push(`open:${id}`)] }
    if (id === "@/lib/i18n/provider") return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === "@/lib/format") return new Proxy({}, { get: () => (value: unknown) => String(value) })
    if (id.startsWith("@/")) return new Proxy({}, { get: (_, name) => String(name) })
    return require(id)
  } })
  assert.ok(exports.LogsClient)
  const tree = exports.LogsClient({ events: [{ requestId: "clicked-row", ts: 0, usage: {}, cost: {}, status: "ok" }], total: 1, limit: 50, offset: 0, baseQuery: "" })
  function findRow(node: any): any {
    if (Array.isArray(node)) return node.map(findRow).find(Boolean)
    if (!node || typeof node !== "object") return null
    if (node.type === "tr" && node.props.onClick) return node
    return findRow(node.props?.children)
  }
  const row = findRow(tree)
  assert.ok(row)
  row.props.onClick({ currentTarget: { querySelector: (selector: string) => {
    assert.equal(selector, "button")
    return { focus: () => calls.push("focus") }
  } } })
  assert.deepEqual(calls, ["focus", "open:clicked-row"])
})
