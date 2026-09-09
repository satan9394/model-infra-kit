/**
 * `model-infra-kit/server` — the HTTP surface of a hub.
 *
 * ```ts
 * import { ModelInfra } from "model-infra-kit"
 * import { createServer } from "model-infra-kit/server"
 *
 * const mik = await ModelInfra.init({ appId: "my-app" })
 * const server = await createServer({ hub: mik, token: process.env.MIK_TOKEN })
 * // Any OpenAI client: new OpenAI({ baseURL: server.url + "/v1", apiKey: token })
 * ```
 */
export { createServer, DEFAULT_HEARTBEAT_MS, DEFAULT_HOST, DEFAULT_PORT, type ServerHandle, type ServerOptions } from "./server.js"

export { HttpError, type ServerContext } from "./context.js"
export { EventBus, type HubEvent, type HubEventName } from "./events.js"
export { buildOpenApiDocument } from "./openapi.js"
export { Router, type Handler } from "./router.js"
export { MAX_BODY_BYTES, type CorsOptions } from "./http.js"
