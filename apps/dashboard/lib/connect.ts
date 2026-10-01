export const FRAMEWORKS = ["ai", "openai-node", "openai-python", "langchain", "curl"] as const
export type Framework = typeof FRAMEWORKS[number]

/** Only a public endpoint and model reference enter generated code. */
export function publicBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("HTTP endpoint required")
  url.username = ""; url.password = ""; url.search = ""; url.hash = ""
  return `${url.toString().replace(/\/+$/, "")}/v1`
}

export function connectionSnippet(framework: Framework, baseUrl: string, model: string): string {
  const base = JSON.stringify(baseUrl)
  const ref = JSON.stringify(model)
  const messages = '[{ role: "user", content: "Hi!" }]'
  switch (framework) {
    case "ai": return `import { generateText } from "ai"\nimport { createOpenAI } from "@ai-sdk/openai"\n\nconst gateway = createOpenAI({ baseURL: ${base}, apiKey: process.env.MIK_SERVER_TOKEN })\nconst result = await generateText({\n  model: gateway.chat(${ref}), // OpenAI-compatible chat endpoint\n  messages: ${messages},\n})\nconsole.log(result.text)`
    case "openai-node": return `import OpenAI from "openai"\n\nconst client = new OpenAI({ baseURL: ${base}, apiKey: process.env.MIK_SERVER_TOKEN })\nconst result = await client.chat.completions.create({\n  model: ${ref},\n  messages: ${messages},\n})\nconsole.log(result.choices[0]?.message.content)`
    case "openai-python": return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url=${base}, api_key=os.environ["MIK_SERVER_TOKEN"])\nresult = client.chat.completions.create(\n    model=${ref},\n    messages=[{"role": "user", "content": "Hi!"}],\n)\nprint(result.choices[0].message.content)`
    case "langchain": return `import os\nfrom langchain_openai import ChatOpenAI\n\nmodel = ChatOpenAI(\n    base_url=${base},\n    api_key=os.environ["MIK_SERVER_TOKEN"],\n    model=${ref},\n)\nprint(model.invoke("Hi!").content)`
    case "curl": {
      const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
      const payload = JSON.stringify({ model, messages: [{ role: "user", content: "Hi!" }] })
      return `curl ${quote(`${baseUrl}/chat/completions`)} -H "Authorization: Bearer $MIK_SERVER_TOKEN" -H 'Content-Type: application/json' -d ${quote(payload)}`
    }
  }
}
