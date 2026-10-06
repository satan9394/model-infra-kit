import type { ProviderStatus } from "./types"

export function providerStatusText(status: ProviderStatus, t: (key: string, ...args: unknown[]) => string): string {
  if (!status.ok) return t("provider.offline")
  if (status.modelCount !== undefined && status.latencyMs !== undefined) return t("provider.connectedModelsLatency", status.modelCount, status.latencyMs)
  if (status.modelCount !== undefined) return t("provider.connectedModels", status.modelCount)
  if (status.latencyMs !== undefined) return t("provider.connectedLatency", status.latencyMs)
  return t("provider.connected")
}

/** Upstream details have already passed the server's credential redactor. */
export function providerProbeError(status: { errorCode?: string; message: string }, t: (key: string, ...args: unknown[]) => string): string {
  const keys: Record<string, string> = {
    AUTH: "provider.probeAuth",
    CREDENTIAL: "provider.probeCredential",
    TIMEOUT: "provider.probeTimeout",
    RATE_LIMIT: "provider.probeRateLimit",
    PROVIDER: "provider.probeProvider",
    CONNECTION: "provider.offline",
  }
  const message = t(keys[status.errorCode ?? ""] ?? "provider.offline")
  return status.errorCode === "TIMEOUT" || !status.message ? message : t("provider.probeErrorDetail", message, status.message)
}
