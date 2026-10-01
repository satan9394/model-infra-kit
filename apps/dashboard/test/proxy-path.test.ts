import assert from "node:assert/strict"
import test from "node:test"
import { isMikProxyPath } from "../lib/proxy-path.ts"

test("model details, probe and default allow encoded namespace identifiers", () => {
  for (const suffix of [[], ["ping"], ["default"]]) assert.equal(isMikProxyPath(["models", "p:namespace/model", ...suffix]), true)
  assert.equal(isMikProxyPath(["budget", "status"]), true)
  assert.equal(isMikProxyPath(["providers", "p", "test"]), true)
})
test("proxy paths reject traversal, separators outside refs and double encoding", () => {
  for (const path of [[], [".."], ["models", "p:../secret"], ["models", "p:a/../../secret"], ["models", "p:a//b"], ["providers", "a/b"], ["models", "p:a%2Fb"], ["models", "p:a\\b"], ["models", "p:a", "../ping"]]) assert.equal(isMikProxyPath(path), false)
})
