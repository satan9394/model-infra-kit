/**
 * `mik` interactive REPL — slash commands with bilingual descriptions, free-text
 * chat through the default model, and a `/lang` switch that persists.
 *
 * Design notes:
 * - Node built-ins only (`node:readline/promises`).
 * - Everything must also be testable headless, so the pure parts
 *   (`parseSlash`, `replHelp`, `resolveLangChoice`) are separated from the TTY
 *   loop and exported.
 */
import { createInterface } from "node:readline/promises"
import type { ParsedCli } from "./args.js"
import { messageOf, openContext, resolveEnv, resolveIo, type CliContext, type RunOptions } from "./context.js"
import { formatMoney } from "./format.js"
import { isLang, LANGS, LANG_LABELS, parseLangChoice, resolveLang, tr, trBoth, type Lang } from "./i18n.js"
import { runCommand } from "./dispatch.js"
import { isInteractive, prompt } from "./prompt.js"
import { redact } from "../util/redact.js"

export const EXIT_USAGE = 2

export interface SlashCommand {
  name: string
  summaryKey: string
  /** argv for `runCommand()`; the REPL handles help/lang/chat/exit itself. */
  argv: (arg: string) => string[]
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", summaryKey: "slash.help", argv: () => [] },
  { name: "lang", summaryKey: "slash.lang", argv: () => [] },
  { name: "providers", summaryKey: "slash.providers", argv: () => ["provider", "list"] },
  { name: "models", summaryKey: "slash.models", argv: (arg) => ["models", ...arg.split(/\s+/).filter(Boolean)] },
  { name: "pricing", summaryKey: "slash.pricing", argv: () => ["pricing", "list"] },
  { name: "usage", summaryKey: "slash.usage", argv: (arg) => ["usage", "summary", ...arg.split(/\s+/).filter(Boolean)] },
  { name: "chat", summaryKey: "slash.chat", argv: () => [] },
  { name: "exit", summaryKey: "slash.exit", argv: () => [] },
]

/** `/name arg rest` → `{ name, arg }`; `null` when the line is not a slash command. */
export function parseSlash(line: string): { name: string; arg: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return null
  const [name, ...rest] = trimmed.slice(1).split(/\s+/)
  return { name: name ?? "", arg: rest.join(" ") }
}

/** Bilingual help: every slash command with its 中文 / English description. */
export function replHelp(): string {
  return SLASH_COMMANDS.map((command) => `/${command.name.padEnd(10)} ${trBoth(command.summaryKey)}`).join("\n")
}

/** `/lang zh|en`, `1`/`2`, or an explicit `zh`/`en`. */
export function resolveLangChoice(value: string): Lang | null {
  const parsed = parseLangChoice(value)
  if (parsed) return parsed
  const normalized = value.trim().toLowerCase()
  if (isLang(normalized)) return normalized
  return null
}

export interface ReplDeps {
  parsed: ParsedCli
  options: RunOptions
  context: CliContext
}

/**
 * Handle a single input line. Shared between the TTY loop and headless tests.
 * `ask` lets the caller answer interactive sub-questions on its own input
 * channel (the REPL injects its readline); without it, `/lang` falls back to
 * `prompt()` so headless tests keep working.
 * Returning `true` means the REPL should exit.
 */
export async function handleLine(
  deps: ReplDeps,
  currentLang: Lang,
  setLang: (lang: Lang) => void,
  line: string,
  ask?: (question: string) => Promise<string>,
): Promise<{ exit: boolean; lang: Lang }> {
  const { parsed, options, context } = deps
  const io = resolveIo(options)
  let lang = currentLang
  const trimmed = line.trim()
  if (!trimmed) return { exit: false, lang }

  const slash = parseSlash(trimmed)
  if (slash) {
    const name = slash.name
    if (name === "help") {
      io.out(replHelp())
      return { exit: false, lang }
    }
    if (name === "lang") {
      let raw = slash.arg
      if (!raw.trim()) {
        const question = "Select language (zh / en): "
        raw = ask ? await ask(question) : await prompt(question)
      }
      const next = resolveLangChoice(raw.trim())
      if (!next) {
        io.err(tr(lang, "repl.langInvalid"))
        return { exit: false, lang }
      }
      // Persist regardless of who drives the loop, then let the caller track it.
      context.hub.writeSetting("cli.lang", next)
      setLang(next)
      lang = next
      io.out(tr(lang, "repl.langSet", LANG_LABELS[lang]))
      return { exit: false, lang }
    }
    if (name === "chat") {
      if (!slash.arg.trim()) {
        io.err("Usage: /chat <prompt>")
        return { exit: false, lang }
      }
      await chatScript(context, options, lang, slash.arg.trim())
      return { exit: false, lang }
    }
    if (name === "exit") {
      io.out(tr(lang, "repl.exit"))
      return { exit: true, lang }
    }
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === name)
    if (!command) {
      io.err(tr(lang, "repl.unknownCmd", `/${name}`))
      return { exit: false, lang }
    }
    await runCommand(command.argv(slash.arg), { ...options, interactive: false })
    return { exit: false, lang }
  }

  // Free text: chat with the default model.
  await chatScript(context, options, lang, trimmed)
  return { exit: false, lang }
}

async function chatScript(context: CliContext, options: RunOptions, lang: Lang, content: string) {
  const io = resolveIo(options)
  const defaultModel = context.hub.providers.defaultModel()
  if (!defaultModel) {
    io.err(tr(lang, "repl.noDefault"))
    return
  }
  try {
    const reply = await context.hub.generate({ messages: [{ role: "user", content }] })
    io.out(reply.text)
    io.out(tr(lang, "repl.chatCost", formatMoney(reply.cost.usd), reply.model.actual, reply.cost.source))
  } catch (error) {
    io.err(tr(lang, "repl.chatError", redact(messageOf(error))))
  }
}

/** Interactive REPL entry. Requires a TTY; tests drive `handleLine` instead. */
export async function runRepl(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const io = resolveIo(options)
  if (!isInteractive(options)) {
    io.err(tr("zh", "repl.notty"))
    return EXIT_USAGE
  }
  const context = await openContext(parsed, options)
  try {
    // Converged on `i18n.resolveLang`: env MIK_LANG → stored cli.lang → zh.
    let lang = resolveLang(resolveEnv(options).MIK_LANG, context.hub.readSetting("cli.lang") ?? undefined)
    const setLang = (next: Lang) => {
      lang = next
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer: (line) => {
        const prefix = line.startsWith("/") ? line : "/"
        const hits = SLASH_COMMANDS.filter((command) => `/${command.name}`.startsWith(prefix)).map((command) => `/${command.name}`)
        return [hits.length > 0 ? hits : SLASH_COMMANDS.map((command) => `/${command.name}`), line]
      },
    })
    try {
      // A bare `/lang` is answered on the REPL's own readline, never a second
      // interface on the same stdin.
      const ask = (question: string) => rl.question(question)
      io.out(tr(lang, "repl.welcome"))
      io.out(tr(lang, "repl.hintChat"))
      for (;;) {
        let line: string
        try {
          line = await rl.question(tr(lang, "repl.prompt") + " ")
        } catch {
          // EOF (Ctrl+D) or a closed stream: leave cleanly.
          break
        }
        const result = await handleLine({ parsed, options, context }, lang, setLang, line, ask)
        lang = result.lang
        if (result.exit) break
      }
      return 0
    } finally {
      rl.close()
    }
  } finally {
    await context.close()
  }
}

/** Languages the REPL accepts, exposed for help screens. */
export const REPL_LANGS: readonly Lang[] = LANGS