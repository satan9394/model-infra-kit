import assert from "node:assert/strict"
import test from "node:test"
import { createConnectionProbe, type ProbeState } from "../lib/connection-probe.ts"

const snapshot = { active: 1, requests: 1, events: 0, connections: [{ id: "r", kind: "chat", startedAt: 1, model: "p:model" }] }
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
