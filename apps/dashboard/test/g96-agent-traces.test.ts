import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { translator } from "../lib/i18n/core.ts"
import { formatUsdSpan } from "../lib/format.ts"

const traces = readFileSync(new URL("../components/views/traces.tsx", import.meta.url), "utf8")
const navigation = readFileSync(new URL("../components/nav.tsx", import.meta.url), "utf8")

test("EVO-G96: Agent trace groups show cost bands, reasoning tokens, and archived detail state", () => {
  assert.match(navigation, /href: "\/traces", label: message\("s129"\)/)
  assert.equal(translator("zh")("s129"), "智能体任务")
  assert.equal(translator("en")("s129"), "Agent tasks")
  assert.match(traces, /loadTraces\(query, groupBy\)/)
  assert.match(traces, /formatUsdSpan\(group\.costLowUsd, group\.costHighUsd\)/)
  assert.match(traces, /formatUsdSpan\(active\.costLowUsd, active\.costHighUsd\)/)
  assert.match(traces, /event\.usage\.reasoning/)
  assert.match(traces, /archivedRequests/)
  assert.equal(formatUsdSpan(0.000003, 0.000007), "$0.000003 ~ $0.000007")
})
