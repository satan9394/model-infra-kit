/**
 * Minimal zh/en localization for user-facing CLI surfaces (REPL, first-run
 * wizard, guided output). Scope is intentionally small: structural output
 * (tables, numbers) stays language-neutral; these keys cover words, hints and
 * next-step guidance.
 */

export type Lang = "zh" | "en"

export const LANGS: readonly Lang[] = ["zh", "en"]
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "English" }

const DICT: Record<string, { zh: string; en: string }> = {
  "repl.welcome": { zh: "mik 交互模式 —— 输入 /help 查看斜杠命令", en: "mik interactive mode — type /help for slash commands" },
  "repl.hintChat": { zh: "没有斜杠时直接输入文字 = 用默认模型对话", en: "Any non-slash line talks to the default model" },
  "repl.langSet": { zh: "语言已切换为 %s", en: "Language switched to %s" },
  "repl.langInvalid": { zh: "语言必须是 zh 或 en", en: "Language must be zh or en" },
  "repl.unknownCmd": { zh: "未知命令 %s —— 输入 /help 查看", en: "Unknown command %s — type /help" },
  "repl.notty": { zh: "交互模式需要一个终端。请在交互式终端里运行 mik。", en: "Interactive mode needs a TTY. Run mik in an interactive terminal." },
  "repl.noDefault": {
    zh: "还没有默认模型。先 /providers 查看，或用 mik provider add … 添加供应商并设置默认模型。",
    en: "No default model yet. Run /providers, or add a provider and set a default model.",
  },
  "repl.chatError": { zh: "对话失败：%s", en: "Chat failed: %s" },
  "repl.chatCost": { zh: "成本 %s · 模型 %s · 来源 %s", en: "cost %s · model %s · source %s" },
  "repl.exit": { zh: "再见 👋", en: "Bye 👋" },
  "repl.prompt": { zh: "mik>", en: "mik>" },
  "slash.help": { zh: "显示所有斜杠命令", en: "Show all slash commands" },
  "slash.lang": { zh: "切换语言 zh / en", en: "Switch language zh / en" },
  "slash.providers": { zh: "列出供应商与默认模型", en: "List providers and the default model" },
  "slash.models": { zh: "查看模型目录（--refresh 触发发现）", en: "Show the model catalogue (--refresh rediscovers)" },
  "slash.pricing": { zh: "查看价格表与手动价", en: "Show the pricing table and manual overrides" },
  "slash.usage": { zh: "查看用量汇总（--limit n 限制条数）", en: "Show the usage summary (--limit n)" },
  "slash.chat": { zh: "用默认模型对话", en: "Chat with the default model" },
  "slash.exit": { zh: "退出", en: "Exit" },
  "wizard.lang": { zh: "选择语言 / Choose a language (1: 中文  2: English): ", en: "Select (1: 中文  2: English): " },
  "wizard.langInvalid": { zh: "请输入 1 或 2", en: "Please enter 1 or 2" },
  "wizard.appId": { zh: "应用 id [%s]: ", en: "Application id [%s]: " },
  "wizard.db": { zh: "SQLite 数据库路径 [%s]: ", en: "SQLite database path [%s]: " },
  "wizard.provider": { zh: "首个供应商预设（留空跳过）[%s]: ", en: "First provider preset (blank to skip) [%s]: " },
  "wizard.nextStepsTitle": { zh: "下一步（Next steps）", en: "Next steps" },
  "wizard.done": { zh: "配置完成。你已经能用了：", en: "Config ready. You are set up:" },
  "wizard.stepSetProvider": { zh: "设置供应商密钥后再继续", en: "set the provider credential, then continue" },
  "wizard.stepTest": { zh: "测试连接 mik provider test <id>", en: "test the connection: mik provider test <id>" },
  "wizard.stepModels": { zh: "拉取模型目录 mik models --provider <id> --refresh", en: "fetch the catalogue: mik models --provider <id> --refresh" },
  "wizard.stepServe": { zh: "起服务 mik serve（OpenAI 兼容端点 127.0.0.1:3211）", en: "start the service: mik serve (OpenAI-compatible on 127.0.0.1:3211)" },
  "wizard.stepDashboard": { zh: "开看板 mik dashboard（3210）", en: "open the dashboard: mik dashboard (3210)" },
  "wizard.stepRepl": { zh: "或直接运行 mik 进入交互模式（斜杠命令 /help）", en: "or just run mik to enter interactive mode (/help)" },
}

export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICT, key)
}

/** All dict keys, for parity tests. */
export function i18nKeys(): readonly string[] {
  return Object.keys(DICT)
}

/** Translate `key` with positional `%s` args (kept in English for numbers/paths). */
export function tr(lang: Lang, key: string, ...args: unknown[]): string {
  const row = DICT[key]
  if (!row) return key
  let text = row[lang] ?? row.zh
  for (const arg of args) text = text.replace("%s", String(arg))
  return text
}

/** Both languages side by side, e.g. for slash-command help. */
export function trBoth(key: string): string {
  const row = DICT[key]
  if (!row) return key
  return `${row.zh} / ${row.en}`
}

/** Every key as a flat record for a language, for callers that pass keys around. */
export function dictFor(lang: Lang): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(DICT)) out[key] = tr(lang, key)
  return out
}

export function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en"
}

/** `MIK_LANG` env or the stored setting; defaults to zh. */
export function resolveLang(value: string | undefined, stored: string | undefined): Lang {
  if (isLang(value)) return value
  if (isLang(stored)) return stored
  return "zh"
}

/** Map a wizard/`/lang` answer ("1" | "2" | "zh" | "en") to a Lang or null. */
export function parseLangChoice(value: string): Lang | null {
  const v = value.trim().toLowerCase()
  if (v === "1" || v === "zh") return "zh"
  if (v === "2" || v === "en") return "en"
  return null
}