import { sendJson } from "../http.js"
import type { Router } from "../router.js"

export function registerQoSRoutes(router: Router): void {
  router.add("GET", "/api/providers/qos", ctx => {
    // sendJson applies redactDeep at the response boundary; no payload/error data retained.
    sendJson(ctx.res, 200, { channels: ctx.hub.providerQoS(), circuits: ctx.hub.providerHealth.snapshot() })
  })
}
