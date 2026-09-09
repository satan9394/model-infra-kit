export type ModelInfraErrorCode =
  | "AUTH"
  | "CONNECTION"
  | "RATE_LIMIT"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_NOT_FOUND"
  | "INVALID_REQUEST"
  | "PROVIDER"
  | "TIMEOUT"
  | "PRICING_UNAVAILABLE"
  | "CREDENTIAL"
  | "STORAGE"
  | "UNKNOWN"

export interface ModelInfraErrorOptions {
  code?: ModelInfraErrorCode
  providerId?: string
  model?: string
  status?: number
  retryable?: boolean
  cause?: unknown
}

/**
 * The only error type hosts are expected to catch. The `message` is safe to
 * show a user; `cause` keeps the original failure for debug logs.
 */
export class ModelInfraError extends Error {
  readonly code: ModelInfraErrorCode
  readonly providerId?: string
  readonly model?: string
  readonly status?: number
  readonly retryable: boolean
  override readonly cause?: unknown

  constructor(message: string, options: ModelInfraErrorOptions = {}) {
    super(message)
    this.name = "ModelInfraError"
    this.code = options.code ?? "UNKNOWN"
    this.providerId = options.providerId
    this.model = options.model
    this.status = options.status
    this.retryable = options.retryable ?? false
    this.cause = options.cause
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      providerId: this.providerId,
      model: this.model,
      status: this.status,
      retryable: this.retryable,
    }
  }
}

export function isModelInfraError(value: unknown): value is ModelInfraError {
  return value instanceof ModelInfraError
}

/**
 * Map an unknown provider/transport failure onto a stable code plus a message
 * that is safe to display. The original error is preserved as `cause`.
 */
export function toModelInfraError(error: unknown, context: ModelInfraErrorOptions = {}): ModelInfraError {
  if (isModelInfraError(error)) return error

  const status = readStatus(error)
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()

  if (status === 401 || status === 403 || /unauthor|invalid api key|authentication/.test(lower)) {
    return new ModelInfraError("API key rejected by the provider. Check the credential for this provider.", {
      ...context,
      code: "AUTH",
      status,
      retryable: false,
      cause: error,
    })
  }
  if (status === 404 || /model.*not found|does not exist|unknown model/.test(lower)) {
    return new ModelInfraError("The provider does not recognise this model id.", {
      ...context,
      code: "MODEL_NOT_FOUND",
      status,
      retryable: false,
      cause: error,
    })
  }
  if (status === 429 || /rate limit|too many requests|quota/.test(lower)) {
    return new ModelInfraError("The provider is rate limiting this key. Retry after a short delay.", {
      ...context,
      code: "RATE_LIMIT",
      status,
      retryable: true,
      cause: error,
    })
  }
  if (status === 408 || status === 504 || /timeout|timed out|etimedout|aborted/.test(lower)) {
    return new ModelInfraError("The provider did not respond in time.", {
      ...context,
      code: "TIMEOUT",
      status,
      retryable: true,
      cause: error,
    })
  }
  if (status === 400 || status === 422 || /invalid request|bad request/.test(lower)) {
    return new ModelInfraError("The provider rejected the request as invalid.", {
      ...context,
      code: "INVALID_REQUEST",
      status,
      retryable: false,
      cause: error,
    })
  }
  if (/fetch failed|econnrefused|enotfound|econnreset|network|socket hang up/.test(lower)) {
    return new ModelInfraError("Could not reach the provider endpoint. Check the base URL and network.", {
      ...context,
      code: "CONNECTION",
      retryable: true,
      cause: error,
    })
  }
  if (typeof status === "number" && status >= 500) {
    return new ModelInfraError("The provider returned a server error.", {
      ...context,
      code: "PROVIDER",
      status,
      retryable: true,
      cause: error,
    })
  }

  return new ModelInfraError(raw || "Unknown provider failure.", { ...context, code: "UNKNOWN", cause: error })
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  for (const key of ["status", "statusCode", "code"]) {
    const value = record[key]
    if (typeof value === "number") return value
  }
  const response = record.response
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>).status
    if (typeof status === "number") return status
  }
  const data = record.data
  if (data && typeof data === "object") {
    const status = (data as Record<string, unknown>).statusCode
    if (typeof status === "number") return status
  }
  return undefined
}
