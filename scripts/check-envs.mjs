#!/usr/bin/env node
/**
 * `/mik check envs`-style CI helper for this repo: runs an offline battery that
 * exercises the CLI bin (direct + npm symlink regression), `mik serve`, the
 * OpenAI-compatible endpoint, usage recording and the python host — in
 * Windows PowerShell, Git Bash and WSL2 Ubuntu (when available).
 *
 * Usage: node scripts/check-envs.mjs
 *   Env overrides: MIK_GIT_BASH=<path to bash.exe>
 *   Exit 0 = all environments that could run passed; non-zero = failures.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BATTERY_SH = join(ROOT, "scripts", "check-envs", "battery.sh")
const BATTERY_PS1 = join(ROOT, "scripts", "check-envs", "battery.ps1")

function run(label, cmd, args, opts = {}) {
  const child = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 180_000,
    cwd: ROOT,
    ...opts,
  })
  const out = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
  const ok = child.status === 0 && /ENV_OK/.test(out)
  return { label, ok, out }
}

function ensureDist() {
  if (existsSync(join(ROOT, "packages", "mik", "dist", "cli.mjs"))) return
  console.log("dist 不存在，先构建 …")
  const build = spawnSync("pnpm", ["--filter", "model-infra-kit", "build"], { encoding: "utf8", cwd: ROOT, timeout: 300_000 })
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout || "build failed")
    process.exit(2)
  }
}

/** `E:\a\b` → `/e/a/b` (msys) and `/mnt/e/a/b` (WSL). */
function unixRoot(style) {
  const win = ROOT.replace(/\\/g, "/") // E:/... or C:/...
  const drive = win[0].toLowerCase()
  const rest = win.slice(2) // /a/b
  return style === "wsl" ? `/mnt/${drive}${rest}` : `/${drive}${rest}`
}

function main() {
  ensureDist()
  const results = []
  const work = mkdtempSync(join(tmpdir(), "mik-envs-"))

  // 1. Windows PowerShell
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "echo ok"], { encoding: "utf8" }).status === 0 ? "pwsh" : "powershell.exe"
  results.push(
    run("powershell", pwsh, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BATTERY_PS1,
      "powershell", ROOT, "3231", "3312", join(work, "ps.db"),
    ]),
  )

  // 2. Git Bash
  const gitBash = process.env.MIK_GIT_BASH || "D:\\Technology_application\\Git\\usr\\bin\\bash.exe"
  if (existsSync(gitBash)) {
    const gbRoot = unixRoot("msys") // /e/DeepSeek_Harness/...
    const gbTarget = `${ROOT.replace(/\\/g, "/")}/packages/mik/dist/cli.mjs` // E:/... native
    // Windows-native absolute DB path: msys `/tmp/...` confuses Windows node:sqlite
    // (it becomes drive-relative), so pass the real temp dir instead.
    const gbDb = join(tmpdir(), `mik-env-gb-${Date.now()}.db`)
    results.push(
      run("git-bash", gitBash, ["-lc", `bash "${gbRoot}/scripts/check-envs/battery.sh" git-bash ${gbRoot} 3232 3313 "${gbDb}" "${gbTarget}" skip`]),
    )
  } else {
    results.push({ label: "git-bash", ok: null, out: "未找到 Git Bash（用 MIK_GIT_BASH 指定）" })
  }

  // 3. WSL2 Ubuntu
  const wslList = (spawnSync("wsl", ["-l", "-q"], { encoding: "utf8" }).stdout || "").replace(/\u0000/g, "")
  if (/Ubuntu/i.test(wslList)) {
    const wslRoot = unixRoot("wsl") // /mnt/e/...
    results.push(
      run("wsl-ubuntu", "wsl", ["-d", "Ubuntu", "--", "bash", `${wslRoot}/scripts/check-envs/battery.sh`, "wsl-ubuntu", wslRoot, "3233", "3314", `/tmp/mik-env-wsl-${Date.now()}.db`, `${wslRoot}/packages/mik/dist/cli.mjs`]),
    )
  } else {
    results.push({ label: "wsl-ubuntu", ok: null, out: "未找到 WSL Ubuntu（wsl -l -q）" })
  }

  rmSync(work, { recursive: true, force: true })

  // Report
  let failed = 0
  for (const { label, ok, out } of results) {
    const status = ok === true ? "PASS" : ok === null ? "SKIP" : "FAIL"
    if (ok === false) failed += 1
    console.log(`${status.padEnd(4)} ${label}`)
    if (ok !== true && ok !== null) {
      const tail = out.trim().split("\n").slice(-6).join("\n")
      console.log(indent(tail))
    }
  }
  console.log(failed === 0 ? "\n全部环境通过。" : `\n${failed} 个环境失败。`)
  process.exit(failed === 0 ? 0 : 1)
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

main()