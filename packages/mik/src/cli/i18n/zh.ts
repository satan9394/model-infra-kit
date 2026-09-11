/**
 * Chinese UI strings for the CLI/REPL surfaces.
 *
 * One flat `Record<string, string>` per language: adding a language means adding
 * one file like this one plus an entry in `cli/i18n.ts`. Key-set parity across
 * languages is enforced by `test/i18n.test.ts` (a missing or extra key fails the
 * suite), so a partial translation can never ship silently.
 */
export const zh: Record<string, string> = {
  "repl.welcome": "mik 交互模式 —— 输入 /help 查看斜杠命令",
  "repl.hintChat": "没有斜杠时直接输入文字 = 用默认模型对话",
  "repl.langSet": "语言已切换为 %s",
  "repl.langInvalid": "语言必须是 zh 或 en",
  "repl.unknownCmd": "未知命令 %s —— 输入 /help 查看",
  "repl.notty": "交互模式需要一个终端。请在交互式终端里运行 mik。",
  "repl.noDefault": "还没有默认模型。先 /providers 查看，或用 mik provider add … 添加供应商并设置默认模型。",
  "repl.chatError": "对话失败：%s",
  "repl.chatCost": "成本 %s · 模型 %s · 来源 %s",
  "repl.exit": "再见 👋",
  "repl.prompt": "mik>",
  "slash.help": "显示所有斜杠命令",
  "slash.lang": "切换语言 zh / en",
  "slash.providers": "列出供应商与默认模型",
  "slash.models": "查看模型目录（--refresh 触发发现）",
  "slash.pricing": "查看价格表与手动价",
  "slash.usage": "查看用量汇总（--limit n 限制条数）",
  "slash.chat": "用默认模型对话",
  "slash.exit": "退出",
  "wizard.lang": "选择语言 / Choose a language (1: 中文  2: English): ",
  "wizard.langInvalid": "请输入 1 或 2",
  "wizard.appId": "应用 id [%s]: ",
  "wizard.db": "SQLite 数据库路径 [%s]: ",
  "wizard.provider": "首个供应商预设（留空跳过）[%s]: ",
  "wizard.nextStepsTitle": "下一步（Next steps）",
  "wizard.done": "配置完成。你已经能用了：",
  "wizard.stepSetProvider": "设置供应商密钥后再继续",
  "wizard.stepTest": "测试连接 mik provider test <id>",
  "wizard.stepModels": "拉取模型目录 mik models --provider <id> --refresh",
  "wizard.stepServe": "起服务 mik serve（OpenAI 兼容端点 127.0.0.1:3211）",
  "wizard.stepDashboard": "开看板 mik dashboard（3210）",
  "wizard.stepRepl": "或直接运行 mik 进入交互模式（斜杠命令 /help）",
}
