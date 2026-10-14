import type { Router } from "../router.js"
import { sendJson } from "../http.js"
import { requireScope } from "../auth.js"

export function registerWebhookRoutes(router: Router): void {
  router.add("GET", "/api/webhooks/status", ctx => {
    requireScope("admin")(ctx)
    sendJson(ctx.res, 200, ctx.hub.webhooks.status())
  })
  router.add("POST", "/api/webhooks/test", ctx => {
    requireScope("admin")(ctx)
    const accepted = ctx.hub.webhooks.test()
    sendJson(ctx.res, accepted ? 202 : 503, { accepted })
  })
  // EVO-G144: durable outbox visibility. Reads are non-mutating; the retry
  // endpoint only re-arms rows an operator explicitly asked to retry.
  router.add("GET", "/api/webhooks/outbox/stats", ctx => {
    requireScope("admin")(ctx)
    sendJson(ctx.res, 200, ctx.hub.webhooks.outboxStats())
  })
  router.add("POST", "/api/webhooks/outbox/retry-dead", ctx => {
    requireScope("admin")(ctx)
    sendJson(ctx.res, 200, ctx.hub.webhooks.retryDeadOutbox())
  })
}
