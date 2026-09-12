import { createRequire } from "node:module"
import { packageForProtocol } from "../registry/index.js"
import type { Protocol } from "../types.js"

/**
 * EVO-G15 (G54) — "the provider package is not installed" is the most common
 * first-run failure, so the CLI tells the user *before* the first request fails.
 *
 * The `@ai-sdk/*` packages stay optional peers (the package must not grow them
 * into hard dependencies), so their presence can only be decided at runtime.
 * The mapping is not repeated here: it is read from the single source of truth
 * in `registry/presets.ts` (`packageForProtocol`).
 *
 * Resolution is injectable so the notice is testable without uninstalling
 * anything: `setPackageResolver()` swaps the probe, `null` restores the real one.
 */
export type PackageResolver = (specifier: string) => boolean

const requireFromCli = createRequire(import.meta.url)

/** The real probe: can this installation resolve `specifier`? */
function defaultResolver(specifier: string): boolean {
  try {
    requireFromCli.resolve(specifier)
    return true
  } catch {
    return false
  }
}

let resolver: PackageResolver = defaultResolver

/** Replace the probe (tests inject a fake); `null` restores the real one. */
export function setPackageResolver(next: PackageResolver | null): void {
  resolver = next ?? defaultResolver
}

/** True when `specifier` resolves from this installation. */
export function isPackageInstalled(specifier: string): boolean {
  return resolver(specifier)
}

/** The `@ai-sdk/*` package a protocol needs, when it cannot be resolved here. */
export function missingPackageForProtocol(protocol: Protocol | undefined | null): string | undefined {
  if (!protocol) return undefined
  const specifier = packageForProtocol(protocol)
  if (!specifier) return undefined
  return isPackageInstalled(specifier) ? undefined : specifier
}

/** Distinct missing packages for a set of provider protocols, in first-seen order. */
export function missingPackagesForProtocols(protocols: readonly (Protocol | undefined)[]): string[] {
  const missing: string[] = []
  for (const protocol of protocols) {
    const specifier = missingPackageForProtocol(protocol)
    if (specifier !== undefined && !missing.includes(specifier)) missing.push(specifier)
  }
  return missing
}
