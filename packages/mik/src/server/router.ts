import type { ServerContext } from "./context.js"

export type Handler = (ctx: ServerContext) => void | Promise<void>

interface Route {
  method: string
  pattern: string
  segments: string[]
  handler: Handler
}

export interface RouteMatch {
  route?: Route
  params: Record<string, string>
  /** Methods registered for this path, for a correct 405 `Allow` header. */
  allowed: string[]
}

/**
 * A minimal segment router. Patterns are literal except for `:name`
 * placeholders, which match exactly one segment (so `/api/models/:ref` accepts
 * the `provider:model` reference, colon and all).
 */
export class Router {
  private readonly routes: Route[] = []

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split("/").filter((segment) => segment.length > 0),
      handler,
    })
    return this
  }

  match(method: string, segments: string[]): RouteMatch {
    const allowed: string[] = []
    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index]!
        const actual = segments[index]!
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = actual
          continue
        }
        if (expected !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue
      if (route.method === method.toUpperCase()) return { route, params, allowed }
      if (!allowed.includes(route.method)) allowed.push(route.method)
    }
    return { params: {}, allowed }
  }

  /** Every registered path, used by the OpenAPI document test surface. */
  get patterns(): string[] {
    return [...new Set(this.routes.map((route) => route.pattern))]
  }
}
