/**
 * examples/agent-cli/pitfalls.ts — the pitfalls the guide warns about, shown
 * with real calls against the workspace source.
 *
 * The "provider package is not installed" pitfall needs its own scratch install
 * (a host with `model-infra-kit` but no `@ai-sdk/*`); see `peer-missing.mjs`.
 *
 * Nothing here touches the network: provider endpoints are never reachable and
 * the price catalogue runs on the bundled archive.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/e2e/loader.mjs examples/agent-cli/pitfalls.ts
 */
import { ModelInfra, isModelInfraError } from "model-infra-kit"

const offlineFetch: typeof globalThis.fetch = async (input) => {
  throw new Error(`offline: refusing to fetch ${typeof input === "string" ? input : "the network"}`)
}

function out(text: string): void {
  process.stdout.write(`${text}\n`)
}

let failures = 0

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1
  out(`    ${ok ? "PASS" : "FAIL"}  ${label}`)
  out(`          ${detail}`)
}

/** Run `action`, returning the ModelInfra error it raised (or null). */
function errorOf(action: () => Promise<unknown> | unknown): Promise<{ code: string; message: string } | null> {
  return Promise.resolve()
    .then(action)
    .then(() => null)
    .catch((error: unknown) => {
      if (isModelInfraError(error)) return { code: error.code, message: error.message }
      return { code: "NON_MODEL_INFRA", message: error instanceof Error ? error.message : String(error) }
    })
}

const initOptions = {
  appId: "agent-cli-pitfalls",
  db: ":memory:",
  syncCatalog: false,
  pricingFetch: offlineFetch,
} as const

out("[1] init() does not validate a provider: an unreachable endpoint only fails at call time")
{
  const mik = await ModelInfra.init({
    ...initOptions,
    // Nothing listens on this port; init() still succeeds (rule: never block
    // startup on an upstream). A host that assumes init() validates is wrong.
    providers: [{ id: "dead", presetId: "custom-openai-compatible", baseUrl: "http://127.0.0.1:45999/v1" }],
  })
  try {
    const error = await errorOf(() => mik.generate({ model: "dead:any", messages: [{ role: "user", content: "hi" }] }))
    check("init() ok, generate() reports a transport code", error?.code === "CONNECTION", `code=${error?.code} message=${error?.message}`)
  } finally {
    await mik.close()
  }
}

out("")
out("[2] seeding the same provider id twice does not overwrite the stored config")
{
  const mik = await ModelInfra.init({
    ...initOptions,
    providers: [{ id: "local", presetId: "custom-openai-compatible", baseUrl: "http://first.example/v1" }],
  })
  try {
    // `ModelInfra.init({ providers })` calls exactly this: an idempotent seed.
    mik.providers.seed([{ id: "local", presetId: "custom-openai-compatible", baseUrl: "http://second.example/v1" }])
    const record = mik.providers.get("local")
    check(
      "the first registration wins",
      record?.baseUrl === "http://first.example/v1",
      `stored baseUrl=${record?.baseUrl} (use providers.add() to change it)`,
    )
  } finally {
    await mik.close()
  }
}

out("")
out("[3] every public member throws STORAGE after close()")
{
  const mik = await ModelInfra.init(initOptions)
  await mik.close()
  const generateError = await errorOf(() => mik.generate({ model: "local:any", messages: [{ role: "user", content: "hi" }] }))
  check("generate() → STORAGE", generateError?.code === "STORAGE", `code=${generateError?.code} message=${generateError?.message}`)
  const usageError = await errorOf(() => mik.usage.summary())
  check("usage.summary() → STORAGE", usageError?.code === "STORAGE", `code=${usageError?.code} message=${usageError?.message}`)
}

out("")
out("[4] a bare model name with no default model is INVALID_REQUEST")
{
  const mik = await ModelInfra.init(initOptions)
  try {
    const error = await errorOf(() => mik.resolveModel("deepseek-chat"))
    check("resolveModel() → INVALID_REQUEST", error?.code === "INVALID_REQUEST", `code=${error?.code} message=${error?.message}`)
  } finally {
    await mik.close()
  }
}

out("")
out(failures === 0 ? "all 4 pitfalls demonstrated" : `${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
