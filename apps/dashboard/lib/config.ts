/**
 * Where the dashboard finds its data.
 *
 * Every read and write goes to the `mik serve` HTTP API (default port 3211).
 * The dashboard never opens the SQLite file: it is a pure HTTP client, which is
 * what keeps it usable against a remote `mik serve` too.
 *
 * Server-side only. Nothing in this file may be imported from a client
 * component, because it reads the bearer token.
 */

export const DEFAULT_MIK_SERVER_URL = "http://127.0.0.1:3211"

/** `MIK_SERVER_URL`, normalised: no trailing slash, never empty. */
export function mikServerUrl(): string {
  const raw = process.env.MIK_SERVER_URL?.trim()
  const value = raw && raw.length > 0 ? raw : DEFAULT_MIK_SERVER_URL
  return value.replace(/\/+$/, "")
}

/**
 * Optional bearer token (`MIK_SERVER_TOKEN`). The mik server only requires it
 * when it was started with `--token`; when it is set here it is attached to
 * every server-side call and to the SSE proxy, and never sent to the browser.
 */
export function mikServerToken(): string | undefined {
  const raw = process.env.MIK_SERVER_TOKEN?.trim()
  return raw && raw.length > 0 ? raw : undefined
}

/** How long a single API call may take before the page falls back to an error state. */
export const MIK_TIMEOUT_MS = 8000

/** Default window of the overview page. */
export const DEFAULT_RANGE_DAYS = 30
