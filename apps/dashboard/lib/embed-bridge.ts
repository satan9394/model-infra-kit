/**
 * Embed host bridge protocol (UI-202 / EVO-G145).
 *
 * The dashboard runs inside a host page's iframe under `/embed/*`. This module
 * defines the *pure* half of the bridge: message schemas, origin allow-list
 * normalisation and message validation. It has no DOM or React dependency, so
 * it can be unit-tested in Node; the DOM wiring (the `message` listener and the
 * `ResizeObserver`) lives in `components/embed-shell.tsx`.
 *
 * Safety rules enforced here:
 *  - an origin is only trusted when it is the embed's own origin or an
 *    explicitly configured host origin; the wildcard `*` is never accepted;
 *  - the `MIK_EMBED_INIT.targetOrigin` a host hands over must equal the origin
 *    the message actually came from, so a host cannot talk us into posting to
 *    somebody else;
 *  - messages carrying token-like keys are rejected outright;
 *  - outbound frames only ever carry a version, a size or a theme, never
 *    request payloads or credentials.
 */

export const EMBED_PROTOCOL_VERSION = "1.0"

export const EMBED_MESSAGE = {
  INIT: "MIK_EMBED_INIT",
  READY: "MIK_EMBED_READY",
  RESIZE: "MIK_EMBED_RESIZE",
  SET_THEME: "MIK_EMBED_SET_THEME",
  ERROR: "MIK_EMBED_ERROR",
} as const

export type EmbedMessageType = (typeof EMBED_MESSAGE)[keyof typeof EMBED_MESSAGE]
export type EmbedTheme = "dark" | "light"

/** Host → Embed: start a session and pin the origin the embed should reply to. */
export interface EmbedInitMessage {
  type: typeof EMBED_MESSAGE.INIT
  targetOrigin: string
  theme?: EmbedTheme
  dateRange?: EmbedRangePreset
}
/** Host → Embed: switch the dashboard theme. */
export interface EmbedSetThemeMessage {
  type: typeof EMBED_MESSAGE.SET_THEME
  theme: EmbedTheme
}
export type EmbedHostMessage = EmbedInitMessage | EmbedSetThemeMessage

/** Embed → Host: handshake accepted. */
export interface EmbedReadyMessage {
  type: typeof EMBED_MESSAGE.READY
  version: string
}
/** Embed → Host: current content size, so the host can size the iframe. */
export interface EmbedResizeMessage {
  type: typeof EMBED_MESSAGE.RESIZE
  height: number
  width: number
}
/** Embed → Host: a rejected or failed interaction, for host-side diagnostics. */
export interface EmbedErrorMessage {
  type: typeof EMBED_MESSAGE.ERROR
  code: string
  message: string
}
export type EmbedClientMessage = EmbedReadyMessage | EmbedResizeMessage | EmbedErrorMessage

export type HostMessageRejection =
  | "origin"
  | "negotiated-origin"
  | "shape"
  | "sensitive"
  | "target"
  | "payload"

export type HostMessageResult =
  | { ok: true; origin: string; message: EmbedHostMessage }
  | { ok: false; reason: HostMessageRejection }

const THEMES = ["dark", "light"] as const
const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|credential|cookie)/i

/**
 * The only `dateRange` values a host may request. They mirror the dashboard's
 * own range presets (`lib/range.ts`); a `custom` window needs explicit `from`
 * and `to` query parameters, which the handshake deliberately does not carry.
 */
export const EMBED_RANGE_PRESETS = ["today", "7d", "30d"] as const
export type EmbedRangePreset = (typeof EMBED_RANGE_PRESETS)[number]

/**
 * Normalise a candidate origin. Returns `null` for anything that must never be
 * trusted: empty values, the wildcard, opaque (`null`) origins, and values that
 * are not absolute URLs. Hostnames are lower-cased and default ports dropped by
 * the URL parser, so `https://Host.EXAMPLE:443` and `https://host.example`
 * compare equal.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "*" || trimmed === "null") return null
  try {
    const origin = new URL(trimmed).origin
    return origin === "null" ? null : origin.toLowerCase()
  } catch {
    return null
  }
}

/** Parse `MIK_EMBED_ALLOWED_ORIGINS` (comma separated). The wildcard is dropped. */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return []
  const unique = new Set<string>()
  for (const part of raw.split(",")) {
    const origin = normalizeOrigin(part)
    if (origin) unique.add(origin)
  }
  return [...unique]
}

/** True when `origin` is the embed's own origin or an explicitly allowed host. */
export function isTrustedOrigin(
  origin: unknown,
  allowedOrigins: readonly string[],
  selfOrigin: unknown,
): boolean {
  const candidate = normalizeOrigin(origin)
  if (!candidate) return false
  const self = normalizeOrigin(selfOrigin)
  if (self && candidate === self) return true
  return allowedOrigins.some((entry) => normalizeOrigin(entry) === candidate)
}

/** Recursively look for token/secret-like keys anywhere in a message payload. */
export function containsSensitiveKeys(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKeys(item, depth + 1))
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) return true
    if (containsSensitiveKeys(item, depth + 1)) return true
  }
  return false
}

function readTheme(value: unknown): EmbedTheme | null {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as EmbedTheme)
    : null
}

function readRange(value: unknown): EmbedRangePreset | null {
  return typeof value === "string" && (EMBED_RANGE_PRESETS as readonly string[]).includes(value)
    ? (value as EmbedRangePreset)
    : null
}

export interface HostMessageContext {
  /** `event.origin` reported by the browser. */
  origin: unknown
  /** Host origins from configuration. */
  allowedOrigins?: readonly string[]
  /** The embed's own origin (`window.location.origin`). Always trusted. */
  selfOrigin?: string
  /** Once a handshake succeeded, only this origin may keep talking. */
  negotiatedOrigin?: string | null
}

/**
 * Validate an incoming host message. A rejection is *silent*: callers must drop
 * the message and never post anything back to an untrusted origin.
 */
export function validateHostMessage(data: unknown, context: HostMessageContext): HostMessageResult {
  const origin = normalizeOrigin(context.origin)
  if (!origin) return { ok: false, reason: "origin" }

  const negotiated = context.negotiatedOrigin ? normalizeOrigin(context.negotiatedOrigin) : null
  if (negotiated) {
    if (origin !== negotiated) return { ok: false, reason: "negotiated-origin" }
  } else if (!isTrustedOrigin(origin, context.allowedOrigins ?? [], context.selfOrigin)) {
    return { ok: false, reason: "origin" }
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "shape" }
  }
  const record = data as Record<string, unknown>
  if (typeof record.type !== "string") return { ok: false, reason: "shape" }
  if (containsSensitiveKeys(record)) return { ok: false, reason: "sensitive" }

  if (record.type === EMBED_MESSAGE.INIT) {
    const target = normalizeOrigin(record.targetOrigin)
    // The target the host asks us to post to must be the host's own origin.
    if (!target || target !== origin) return { ok: false, reason: "target" }
    const theme = readTheme(record.theme)
    if (record.theme !== undefined && theme === null) return { ok: false, reason: "payload" }
    const dateRange = readRange(record.dateRange)
    if (record.dateRange !== undefined && dateRange === null) return { ok: false, reason: "payload" }
    return {
      ok: true,
      origin,
      message: {
        type: EMBED_MESSAGE.INIT,
        targetOrigin: target,
        ...(theme ? { theme } : {}),
        ...(dateRange ? { dateRange } : {}),
      },
    }
  }

  if (record.type === EMBED_MESSAGE.SET_THEME) {
    const theme = readTheme(record.theme)
    if (theme === null) return { ok: false, reason: "payload" }
    return { ok: true, origin, message: { type: EMBED_MESSAGE.SET_THEME, theme } }
  }

  return { ok: false, reason: "shape" }
}

export function buildReadyMessage(version: string = EMBED_PROTOCOL_VERSION): EmbedReadyMessage {
  return { type: EMBED_MESSAGE.READY, version }
}

export function buildResizeMessage(height: number, width: number): EmbedResizeMessage {
  return {
    type: EMBED_MESSAGE.RESIZE,
    height: Math.max(0, Math.round(Number.isFinite(height) ? height : 0)),
    width: Math.max(0, Math.round(Number.isFinite(width) ? width : 0)),
  }
}

export function buildErrorMessage(code: string, detail = ""): EmbedErrorMessage {
  return { type: EMBED_MESSAGE.ERROR, code, message: String(detail).slice(0, 200) }
}

/** The numeric shape `embedContentSize` needs; keeps the helper DOM-free to test. */
export interface MeasurableElement {
  scrollHeight: number
  offsetHeight: number
  clientWidth: number
  scrollWidth: number
}

/**
 * The real content box, which is the maximum of the document and body metrics:
 * a document can be taller than its body when margins collapse, and the host
 * needs the larger value to avoid an inner scrollbar.
 */
export function embedContentSize(
  documentElement: MeasurableElement,
  body?: MeasurableElement | null,
): { height: number; width: number } {
  const height = Math.max(
    documentElement.scrollHeight,
    documentElement.offsetHeight,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
  )
  const width = Math.max(
    documentElement.clientWidth,
    documentElement.scrollWidth,
    body?.clientWidth ?? 0,
    body?.scrollWidth ?? 0,
  )
  return { height: Math.max(0, Math.round(height)), width: Math.max(0, Math.round(width)) }
}
