/**
 * examples/agent-cli/peer-missing.mjs — "the provider package must be installed
 * separately", demonstrated for real.
 *
 * `@ai-sdk/*` are optional peer dependencies, imported lazily on the first call.
 * This script reproduces the situation of a host that ran `npm i
 * model-infra-kit` and nothing else:
 *
 *   1. it copies the **built** package (`packages/mik/dist` + package.json) into
 *      a scratch `node_modules/model-infra-kit`, exactly what npm would install;
 *   2. it junctions `ai` and `llm-pricing` (the package's own hard dependencies)
 *      so the copy is loadable;
 *   3. it deliberately does **not** provide `@ai-sdk/*`, then calls
 *      `mik.generate()` and prints the error the host would see.
 *
 * Nothing is deleted: each run uses a fresh scratch directory under the OS temp
 * directory (deletion on this machine must go through the recycle bin).
 *
 * Run from the repository root:
 *   node examples/agent-cli/peer-missing.mjs
 */
import { copyFileSync, cpSync, mkdirSync, symlinkSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, "..", "..")
const mikRoot = join(repoRoot, "packages", "mik")
const mikNodeModules = join(mikRoot, "node_modules")

const scratch = join(tmpdir(), `mik-agent-cli-peer-sim-${process.pid}`)
const packageDir = join(scratch, "node_modules", "model-infra-kit")

function log(text) {
  process.stdout.write(`${text}\n`)
}

log(`scratch install: ${packageDir}`)
mkdirSync(join(scratch, "node_modules"), { recursive: true })
cpSync(join(mikRoot, "dist"), join(packageDir, "dist"), { recursive: true })
copyFileSync(join(mikRoot, "package.json"), join(packageDir, "package.json"))
for (const dependency of ["ai", "llm-pricing"]) {
  // A junction works without elevation on Windows, unlike a plain symlink.
  symlinkSync(join(mikNodeModules, dependency), join(scratch, "node_modules", dependency), "junction")
}
log("  installed:     model-infra-kit (dist) + ai + llm-pricing")
log("  NOT installed: @ai-sdk/*  (the optional provider peers)")
log("")

const { ModelInfra, isModelInfraError } = await import(pathToFileURL(join(packageDir, "dist", "index.mjs")).href)

const mik = await ModelInfra.init({
  appId: "peer-missing",
  db: ":memory:",
  syncCatalog: false,
  providers: [{ id: "deepseek", presetId: "deepseek", apiKeyRef: "env:DEEPSEEK_API_KEY" }],
  pricingFetch: async () => {
    throw new Error("offline")
  },
  onWarn: () => {},
})
log("init() with no @ai-sdk/deepseek installed: OK (the import is lazy)")

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "sk-not-a-real-key"

try {
  await mik.generate({ model: "deepseek:deepseek-chat", messages: [{ role: "user", content: "hi" }] })
  log("FAIL  generate() unexpectedly succeeded")
  process.exitCode = 1
} catch (error) {
  const code = isModelInfraError(error) ? error.code : "NON_MODEL_INFRA"
  const message = error instanceof Error ? error.message : String(error)
  log("")
  log("generate() →")
  log(`  code    ${code}`)
  log(`  message ${message}`)
  const ok = code === "PROVIDER" && message.includes("npm i @ai-sdk/deepseek")
  log("")
  log(ok ? "PASS  PROVIDER error naming the exact package to install" : "FAIL  unexpected error shape")
  process.exitCode = ok ? 0 : 1
} finally {
  await mik.close()
}
