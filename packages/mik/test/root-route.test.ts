import { describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"

describe("API root GET / route", () => {
  it("redirects browser HTML requests with 302 to the dashboard providers view", async () => {
    const hub = await ModelInfra.init({ appId: "root-test", db: ":memory:" })
    const server = await createServer({ hub, port: 0, heartbeatMs: 0 })
    try {
      const response = await fetch(`${server.url}/`, {
        headers: { accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
      })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("http://127.0.0.1:3210/providers")
    } finally {
      await server.close()
      await hub.close()
    }
  })

  it("returns 200 JSON with status and endpoints for API callers", async () => {
    const hub = await ModelInfra.init({ appId: "root-test", db: ":memory:" })
    const server = await createServer({ hub, port: 0, heartbeatMs: 0 })
    try {
      const response = await fetch(`${server.url}/`, {
        headers: { accept: "application/json" },
      })
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        status: "ok",
        service: "model-infra-kit",
        version: "1.8.0",
        dashboard: "http://127.0.0.1:3210",
        endpoints: {
          openai: "/v1",
          health: "/api/health",
          providers: "/api/providers",
          models: "/api/models",
        },
      })
    } finally {
      await server.close()
      await hub.close()
    }
  })

  it("is a public route accessible without bearer authentication", async () => {
    const hub = await ModelInfra.init({ appId: "root-test", db: ":memory:" })
    const server = await createServer({
      hub,
      port: 0,
      heartbeatMs: 0,
      tokens: [{ token: "secret-bearer-token", scopes: ["admin"] }],
    })
    try {
      // Unauthenticated request to / must succeed without 401
      const response = await fetch(`${server.url}/`)
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.status).toBe("ok")
      expect(data.service).toBe("model-infra-kit")
    } finally {
      await server.close()
      await hub.close()
    }
  })
})
