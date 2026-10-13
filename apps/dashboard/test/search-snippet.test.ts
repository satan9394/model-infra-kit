import assert from "node:assert/strict"
import test from "node:test"
import { literalSearchQuery, snippetParts } from "../lib/search-snippet.ts"

test("dashboard search treats IDs and hostile punctuation as bounded literal FTS phrases", () => {
  assert.equal(literalSearchQuery("g138-trace-0"), '"g138-trace-0"')
  assert.equal(literalSearchQuery('a" OR * <script>\u0000'), '"a"" OR * <script>"')
  assert.equal(literalSearchQuery("   "), '""')
  assert.ok(literalSearchQuery('"'.repeat(8000)).length <= 4096)
})

test("FTS snippet markers preserve HTML-looking content as plain text", () => {
  assert.deepEqual(snippetParts('<img onerror="alert(1)"> \u0001timeout\u0002 & retry'), [
    { text: '<img onerror="alert(1)"> ', highlighted: false },
    { text: "timeout", highlighted: true }, { text: " & retry", highlighted: false },
  ])
  assert.deepEqual(snippetParts("plain"), [{ text: "plain", highlighted: false }])
})
