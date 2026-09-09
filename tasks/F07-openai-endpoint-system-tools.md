# F07 — OpenAI 兼容端点的 system 消息与 tools（T09 实测发现，指挥读码确认）

**来源**：T09 交证风险 ①
**拥有文件**：`src/server/openai.ts`、`test/server.test.ts`

## 缺陷

`src/server/openai.ts`：
- `toModelMessages()`（L38-57）把 `role: "system"` / `"developer"` 原样塞进 `ModelRequest.messages`，而 AI SDK 的 `generateText` 不接受 messages 里的 system 消息 → **HTTP 500**（`Invalid prompt: System messages are not allowed...`）。
- `handleChatCompletions` 完全没有读 `body.tools`（L161-163 只取了 messages），HTTP 客户端传的工具定义到不了模型。

影响：任何标准 OpenAI 客户端（`openai` SDK、LangChain、Cursor 类工具）第一条 system 消息就会 500；工具调用在代理端点上等于不可用。这是接入面 ① 的核心路径。

## 修法

1. **system/developer**：从 messages 中抽出来，合并成一个 `system` 字符串（多条用 `\n\n` 连接）传给 `ModelRequest.system`；messages 里不再保留。
2. **tools**：把 OpenAI 的 `tools: [{ type: "function", function: { name, description, parameters } }]` 映射成 AI SDK `ToolSet`：`{ [name]: { description, inputSchema: jsonSchema(parameters) } }`，**不要给 `execute`**——代理端点只把 `tool_calls` 返回给客户端，不代替客户端执行。
3. **响应映射**：`result.toolCalls` → OpenAI `choices[0].message.tool_calls`（`{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }`），并把 `finish_reason` 设为 `tool_calls`。
4. **tool 角色消息**：`role: "tool"`（带 `tool_call_id`）应映射成 AI SDK 的 tool result 消息，保证多轮工具对话能跑通。
5. 非法 role 仍返回 400（现有校验保留）。

## 验收（必须真跑并贴真实输出）

1. `POST /v1/chat/completions` 带 `messages: [{role:"system",...},{role:"user",...}]` → **200**（不再 500），且断言上游 mock 收到的是 system 字段而非 messages 里的 system。
2. 带 `tools` 的请求 → 200，响应里出现 `tool_calls`，`finish_reason === "tool_calls"`，`function.name`/`arguments` 正确。
3. 多轮：`user → assistant(tool_calls) → tool(result)` → 200 且上游收到合法的 tool result 消息。
4. 流式（`stream: true`）同样支持 system 与 tools。
5. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/server.test.ts` 全绿，测试数只增不减。
6. 不要改 `src/hub.ts`、`src/cli/**`、`apps/dashboard/**`、`examples/**`。

## 交证

按 `AGENTS.md` 格式，贴出 system 请求从 500 → 200 的前后证据，以及 tools 响应的实际 JSON。
