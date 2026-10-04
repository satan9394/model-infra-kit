import assert from "node:assert/strict"
import test from "node:test"
import { snippetParts } from "../lib/search-snippet.ts"

test("FTS snippet markers preserve HTML-looking content as plain text", () => {
  assert.deepEqual(snippetParts('<img onerror="alert(1)"> \u0001timeout\u0002 & retry'), [
    { text: '<img onerror="alert(1)"> ', highlighted: false },
    { text: "timeout", highlighted: true }, { text: " & retry", highlighted: false },
  ])
  assert.deepEqual(snippetParts("plain"), [{ text: "plain", highlighted: false }])
})
