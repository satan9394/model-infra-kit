import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"
import { resolveLang, translator } from "../lib/i18n/core.ts"

test("dashboard dictionaries have complete key and interpolation parity, with no Chinese English messages", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
    assert.ok(zh[key].trim() && en[key].trim(), key)
    assert.doesNotMatch(en[key], /\p{Script=Han}/u, key)
    assert.deepEqual(zh[key].match(/\{\d+\}/g) ?? [], en[key].match(/\{\d+\}/g) ?? [], key)
  }
})

test("language preference validates storage, follows the browser, and interpolates helper messages", () => {
  assert.equal(resolveLang("en", "zh-CN"), "en")
  assert.equal(resolveLang("zh", "en-US"), "zh")
  assert.equal(resolveLang("invalid", "en-US"), "en")
  assert.equal(resolveLang(null, "zh-TW"), "zh")
  assert.equal(translator("en")("s182", "local", 3), "local: discovered 3 available models")
  assert.equal(translator("en")(translator("zh")("s379", 5)), "5 seconds ago")
  assert.equal(translator("en")(zh.s402), en.s402)
  assert.equal(translator("en")("namespace/model"), "namespace/model")
})

test("view source contains no hardcoded Chinese string, template or JSX text (comments excluded)", () => {
  function scan(dir: URL) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir)
      if (entry.isDirectory()) { if (entry.name !== "i18n") scan(path); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      const ast = ts.createSourceFile(entry.name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, entry.name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
          assert.doesNotMatch((node as ts.StringLiteral).text, /\p{Script=Han}/u, path.pathname)
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
  }
  for (const dir of ["components", "app", "lib"]) scan(new URL(`../${dir}/`, import.meta.url))
})

test("modal dialogs have accessible names, Escape handling and native modal focus", () => {
  for (const file of ["add-provider-modal", "edit-provider-modal", "model-ping-modal", "logs-client"]) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8")
    assert.match(source, /role="dialog"/)
    assert.match(source, /aria-modal="true"/)
    assert.match(source, /aria-labelledby=/)
    assert.match(source, /onCancel=/)
    assert.match(source, /showModal\(\)|useModalDialog\(\)/)
  }
  const provider = readFileSync(new URL("../lib/i18n/provider.tsx", import.meta.url), "utf8")
  assert.match(provider, /localStorage\.setItem/)
  assert.match(provider, /document\.cookie/)
  assert.match(provider, /router\.refresh/)
  assert.doesNotMatch(provider, /router\.push|searchParams/)
})
