import type { ServerContext } from "../context.js"
import type { Router } from "../router.js"
import { sendJson } from "../http.js"

/** Register the read-only advisory budget endpoint. */
export function registerBudgetRoutes(router: Router): void {
  router.add("GET", "/api/budget/status", (ctx: ServerContext) => {
    sendJson(ctx.res, 200, ctx.hub.budgetStatus())
  })
}
