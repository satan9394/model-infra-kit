import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { formatUsdSpan } from "../lib/format.ts"

const trends = readFileSync(new URL("../components/views/trends.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")
const overview = readFileSync(new URL("../components/views/overview.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")

test("EVO-G92: the five real dashboard cost cells render the recorded interval", () => {
  assert.match(trends, /formatUsdSpan\(busiest\.costLowUsd, busiest\.costHighUsd\)/)
  assert.match(trends, /formatUsdSpan\(point\.costLowUsd, point\.costHighUsd\)/)
  assert.equal((overview.match(/formatUsdSpan\(bucket\.costLowUsd, bucket\.costHighUsd\)/g) ?? []).length, 2)
  assert.doesNotMatch(trends, /formatUsd\((?:busiest|point)\.costUsd\)/)
  assert.doesNotMatch(overview, /formatUsd\(bucket\.costUsd\)/)
  assert.equal(formatUsdSpan(0.000345, 0.000788), "$0.000345 ~ $0.000788")
})

test("EVO-G92: busiest-day ordering uses the floor, then upper endpoint for ties", () => {
  const start = trends.indexOf("const busiest = points.reduce")
  const end = trends.indexOf("\n\n  return", start)
  assert.notEqual(start, -1, "the real TrendsView must select its busiest day")
  assert.notEqual(end, -1, "the busiest-day selection must end before the view markup")
  const selection = trends.slice(start, end)

  assert.match(
    selection,
    /point\.costLowUsd > best\.costLowUsd[\s\S]*point\.costLowUsd === best\.costLowUsd && point\.costHighUsd > best\.costHighUsd/,
  )
  assert.doesNotMatch(selection, /costUsd/)
})
