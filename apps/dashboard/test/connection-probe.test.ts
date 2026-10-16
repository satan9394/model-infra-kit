import assert from "node:assert/strict"
import test from "node:test"
import { createConnectionProbe, pickResourceDuration, type ProbeState } from "../lib/connection-probe.ts"

const snapshot = { active: 1, requests: 1, events: 0, connections: [{ id: "r", kind: "chat", startedAt: 1, model: "p:model" }] }
test("the round-trip clock starts after the pending state is published, never before it", async () => {
  const events: string[] = []
  let time = 100
  const probe = createConnectionProbe(
    (state) => { events.push(`publish:${state.status}`) },
    async () => { events.push("fetch"); time += 37; return Response.json(snapshot) },
    () => { events.push("now"); return time },
  )
  await probe.run()
  // Regression: the clock used to be read before `publish({ status: "pending" })`, so the
  // state update was billed to the network round trip it does not belong to.
  assert.deepEqual(events, ["publish:pending", "now", "fetch", "now", "publish:ready"])
  probe.dispose()
})
test("connection probe measures HTTP roundtrip and uses the authenticated dashboard proxy", async () => {
  const states: ProbeState[] = []
  let time = 100
  const probe = createConnectionProbe(state => states.push(state), async (url, options) => {
    assert.equal(url, "/api/mik/connections")
    assert.equal(options?.cache, "no-store")
    assert.ok(options?.signal)
    time += 37
    return Response.json(snapshot)
  }, () => time)
  await probe.run()
  assert.equal(states.at(-1)?.rttMs, 37)
  assert.equal(states.at(-1)?.snapshot?.requests, 1)
  probe.dispose()
})
test("a stalled main thread cannot inflate the reported round trip", async () => {
  const states: ProbeState[] = []
  let time = 100
  const probe = createConnectionProbe(
    state => states.push(state),
    // The wall clock loses 1300ms to main-thread work; the request itself took 54ms.
    async () => { time += 1300; return Response.json(snapshot) },
    () => time,
    (url, since) => { assert.equal(url, "/api/mik/connections"); assert.equal(since, 100); return 54 },
  )
  await probe.run()
  assert.equal(states.at(-1)?.rttMs, 54)
  assert.equal(states.at(-1)?.status, "ready")
  probe.dispose()
})
test("the wall clock is only a fallback when the browser reports no timing entry", async () => {
  const states: ProbeState[] = []
  let time = 100
  const probe = createConnectionProbe(state => states.push(state), async () => { time += 37; return Response.json(snapshot) }, () => time, () => null)
  await probe.run()
  assert.equal(states.at(-1)?.rttMs, 37)
  probe.dispose()
})
test("resource timing picks this request and never an earlier probe's entry", () => {
  const entries = [
    { startTime: 100, duration: 999 },
    { startTime: 5000, duration: 54 },
    { startTime: 4999, duration: 777 },
  ]
  assert.equal(pickResourceDuration(entries, 5000), 54)
  assert.equal(pickResourceDuration(entries, 20000), null, "no entry at or after the dispatch mark")
  assert.equal(pickResourceDuration([], 0), null)
  assert.equal(pickResourceDuration([{ startTime: 1, duration: Number.NaN }], 0), null, "an entry without a duration is not a measurement")
})
test("network and invalid snapshot failures clear counts and RTT instead of faking zero", async () => {
  for (const fetcher of [async () => { throw new Error("offline") }, async () => Response.json({ ...snapshot, requests: -1 }), async () => new Response("denied", { status: 403 })]) {
    const states: ProbeState[] = []
    const probe = createConnectionProbe(state => states.push(state), fetcher)
    await probe.run()
    assert.deepEqual(states.at(-1), { status: "offline", snapshot: null, rttMs: null })
    probe.dispose()
  }
})
test("replacement aborts the older request and ignores its late response; disposal aborts and publishes nothing", async () => {
  const states: ProbeState[] = []
  const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
  const probe = createConnectionProbe(state => states.push(state), async (_url, options) => new Promise<Response>(resolve => {
    requests.push({ signal: options!.signal!, resolve })
  }))
  const first = probe.run()
  const second = probe.run()
  assert.equal(requests[0]!.signal.aborted, true)
  requests[1]!.resolve(Response.json(snapshot)); await second
  const completed = states.length
  requests[0]!.resolve(Response.json({ ...snapshot, requests: 99 })); await first
  assert.equal(states.length, completed)
  const third = probe.run()
  probe.dispose()
  assert.equal(requests[2]!.signal.aborted, true)
  const disposed = states.length
  requests[2]!.resolve(Response.json(snapshot)); await third
  assert.equal(states.length, disposed)
})
