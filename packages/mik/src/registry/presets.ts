import type { Protocol, ProviderPreset } from "../types.js"

/**
 * The `@ai-sdk/*` package that implements each protocol.
 *
 * This is the single source of truth for "protocol → package": the preset table
 * and the AI bridge both read it, so a protocol can never be wired to the wrong
 * implementation by hand.
 */
export const PROTOCOL_PACKAGES: Record<Protocol, string> = {
  openai: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  google: "@ai-sdk/google",
  deepseek: "@ai-sdk/deepseek",
  moonshotai: "@ai-sdk/moonshotai",
  xai: "@ai-sdk/xai",
  "openai-compatible": "@ai-sdk/openai-compatible",
}

/**
 * Shipped provider presets. Adding a provider means adding a row here — never a
 * branch somewhere else in the code.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    "id": "openai",
    "name": "OpenAI",
    "protocol": "openai",
    "npmPackage": "@ai-sdk/openai",
    "category": "global_official",
    "websiteUrl": "https://platform.openai.com",
    "apiKeyUrl": "https://platform.openai.com/api-keys",
    "recommendedModels": [
      "gpt-4.1",
      "gpt-4.1-mini"
    ],
    "docUrl": "https://platform.openai.com/api-keys",
    "defaultBaseUrl": "https://api.openai.com/v1",
    "envKey": "OPENAI_API_KEY"
  },
  {
    "id": "anthropic",
    "name": "Anthropic",
    "protocol": "anthropic",
    "npmPackage": "@ai-sdk/anthropic",
    "category": "global_official",
    "websiteUrl": "https://console.anthropic.com",
    "apiKeyUrl": "https://console.anthropic.com/settings/keys",
    "recommendedModels": [
      "claude-sonnet-4-5"
    ],
    "docUrl": "https://console.anthropic.com/settings/keys",
    "defaultBaseUrl": "https://api.anthropic.com/v1",
    "envKey": "ANTHROPIC_API_KEY"
  },
  {
    "id": "google",
    "name": "Google Gemini",
    "protocol": "google",
    "npmPackage": "@ai-sdk/google",
    "category": "global_official",
    "websiteUrl": "https://aistudio.google.com",
    "apiKeyUrl": "https://aistudio.google.com/apikey",
    "recommendedModels": [
      "gemini-2.5-pro",
      "gemini-2.5-flash"
    ],
    "docUrl": "https://aistudio.google.com/apikey",
    "defaultBaseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "envKey": "GOOGLE_GENERATIVE_AI_API_KEY"
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "protocol": "deepseek",
    "npmPackage": "@ai-sdk/deepseek",
    "category": "cn_official",
    "websiteUrl": "https://platform.deepseek.com",
    "apiKeyUrl": "https://platform.deepseek.com/api_keys",
    "recommendedModels": [
      "deepseek-chat",
      "deepseek-reasoner"
    ],
    "docUrl": "https://platform.deepseek.com/api_keys",
    "defaultBaseUrl": "https://api.deepseek.com/v1",
    "envKey": "DEEPSEEK_API_KEY"
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "protocol": "moonshotai",
    "npmPackage": "@ai-sdk/moonshotai",
    "category": "cn_official",
    "websiteUrl": "https://platform.moonshot.ai",
    "apiKeyUrl": "https://platform.moonshot.ai/console/api-keys",
    "recommendedModels": [
      "kimi-k2-0905-preview"
    ],
    "docUrl": "https://platform.moonshot.ai/console/api-keys",
    "defaultBaseUrl": "https://api.moonshot.ai/v1",
    "envKey": "MOONSHOT_API_KEY"
  },
  {
    "id": "xai",
    "name": "xAI",
    "protocol": "xai",
    "npmPackage": "@ai-sdk/xai",
    "category": "global_official",
    "websiteUrl": "https://console.x.ai",
    "apiKeyUrl": "https://console.x.ai",
    "recommendedModels": [
      "grok-4"
    ],
    "docUrl": "https://console.x.ai",
    "defaultBaseUrl": "https://api.x.ai/v1",
    "envKey": "XAI_API_KEY"
  },
  {
    "id": "zhipu",
    "name": "Zhipu GLM",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://open.bigmodel.cn",
    "apiKeyUrl": "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    "recommendedModels": [
      "glm-4.5"
    ],
    "docUrl": "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    "defaultBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "envKey": "ZHIPU_API_KEY"
  },
  {
    "id": "qwen",
    "name": "Alibaba Bailian (Qwen)",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://bailian.console.aliyun.com",
    "apiKeyUrl": "https://bailian.console.aliyun.com",
    "recommendedModels": [
      "qwen-plus",
      "qwen-turbo"
    ],
    "docUrl": "https://bailian.console.aliyun.com",
    "defaultBaseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "envKey": "DASHSCOPE_API_KEY"
  },
  {
    "id": "doubao",
    "name": "Volcengine (Doubao)",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://console.volcengine.com",
    "apiKeyUrl": "https://console.volcengine.com/ark",
    "recommendedModels": [
      "doubao-seed-1-6-250615"
    ],
    "docUrl": "https://console.volcengine.com/ark",
    "defaultBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "envKey": "ARK_API_KEY"
  },
  {
    "id": "qianfan",
    "name": "Baidu Qianfan",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://console.bce.baidu.com",
    "apiKeyUrl": "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
    "recommendedModels": [
      "ernie-4.5-turbo-128k"
    ],
    "docUrl": "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
    "defaultBaseUrl": "https://qianfan.baidubce.com/v2",
    "envKey": "QIANFAN_API_KEY"
  },
  {
    "id": "hunyuan",
    "name": "Tencent Hunyuan",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://console.cloud.tencent.com",
    "apiKeyUrl": "https://console.cloud.tencent.com/hunyuan/api-key",
    "recommendedModels": [
      "hunyuan-turbos-latest"
    ],
    "docUrl": "https://console.cloud.tencent.com/hunyuan/api-key",
    "defaultBaseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
    "envKey": "HUNYUAN_API_KEY"
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://platform.minimax.io",
    "apiKeyUrl": "https://platform.minimax.io/user-center/basic-information/interface-key",
    "recommendedModels": [
      "MiniMax-M2"
    ],
    "docUrl": "https://platform.minimax.io/user-center/basic-information/interface-key",
    "defaultBaseUrl": "https://api.minimax.io/v1",
    "envKey": "MINIMAX_API_KEY"
  },
  {
    "id": "yi",
    "name": "01.AI",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://platform.lingyiwanwu.com",
    "apiKeyUrl": "https://platform.lingyiwanwu.com/apikeys",
    "recommendedModels": [
      "yi-large"
    ],
    "docUrl": "https://platform.lingyiwanwu.com/apikeys",
    "defaultBaseUrl": "https://api.lingyiwanwu.com/v1",
    "envKey": "YI_API_KEY"
  },
  {
    "id": "stepfun",
    "name": "StepFun",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://platform.stepfun.com",
    "apiKeyUrl": "https://platform.stepfun.com/interface-key",
    "recommendedModels": [
      "step-2-16k"
    ],
    "docUrl": "https://platform.stepfun.com/interface-key",
    "defaultBaseUrl": "https://api.stepfun.com/v1",
    "envKey": "STEPFUN_API_KEY"
  },
  {
    "id": "modelscope",
    "name": "ModelScope",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "cn_official",
    "websiteUrl": "https://modelscope.cn",
    "apiKeyUrl": "https://modelscope.cn/my/myaccesstoken",
    "recommendedModels": [
      "Qwen/Qwen3-235B-A22B"
    ],
    "docUrl": "https://modelscope.cn/my/myaccesstoken",
    "defaultBaseUrl": "https://api-inference.modelscope.cn/v1",
    "envKey": "MODELSCOPE_API_KEY"
  },
  {
    "id": "groq",
    "name": "Groq",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "global_official",
    "websiteUrl": "https://console.groq.com",
    "apiKeyUrl": "https://console.groq.com/keys",
    "recommendedModels": [
      "llama-3.3-70b-versatile"
    ],
    "docUrl": "https://console.groq.com/keys",
    "defaultBaseUrl": "https://api.groq.com/openai/v1",
    "envKey": "GROQ_API_KEY"
  },
  {
    "id": "mistral",
    "name": "Mistral AI",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "global_official",
    "websiteUrl": "https://console.mistral.ai",
    "apiKeyUrl": "https://console.mistral.ai/api-keys",
    "recommendedModels": [
      "mistral-large-latest"
    ],
    "docUrl": "https://console.mistral.ai/api-keys",
    "defaultBaseUrl": "https://api.mistral.ai/v1",
    "envKey": "MISTRAL_API_KEY"
  },
  {
    "id": "perplexity",
    "name": "Perplexity",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "global_official",
    "websiteUrl": "https://www.perplexity.ai",
    "apiKeyUrl": "https://www.perplexity.ai/settings/api",
    "recommendedModels": [
      "sonar",
      "sonar-pro"
    ],
    "docUrl": "https://www.perplexity.ai/settings/api",
    "defaultBaseUrl": "https://api.perplexity.ai",
    "envKey": "PERPLEXITY_API_KEY"
  },
  {
    "id": "cohere",
    "name": "Cohere",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "global_official",
    "websiteUrl": "https://dashboard.cohere.com",
    "apiKeyUrl": "https://dashboard.cohere.com/api-keys",
    "recommendedModels": [
      "command-a-03-2025"
    ],
    "docUrl": "https://dashboard.cohere.com/api-keys",
    "defaultBaseUrl": "https://api.cohere.ai/compatibility/v1",
    "envKey": "COHERE_API_KEY"
  },
  {
    "id": "siliconflow",
    "name": "SiliconFlow",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "aggregator",
    "websiteUrl": "https://cloud.siliconflow.cn",
    "apiKeyUrl": "https://cloud.siliconflow.cn/account/ak",
    "recommendedModels": [
      "deepseek-ai/DeepSeek-V3"
    ],
    "docUrl": "https://cloud.siliconflow.cn/account/ak",
    "defaultBaseUrl": "https://api.siliconflow.cn/v1",
    "envKey": "SILICONFLOW_API_KEY"
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "aggregator",
    "websiteUrl": "https://openrouter.ai",
    "apiKeyUrl": "https://openrouter.ai/settings/keys",
    "recommendedModels": [
      "openai/gpt-4.1"
    ],
    "docUrl": "https://openrouter.ai/settings/keys",
    "defaultBaseUrl": "https://openrouter.ai/api/v1",
    "envKey": "OPENROUTER_API_KEY"
  },
  {
    "id": "together",
    "name": "Together AI",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "aggregator",
    "websiteUrl": "https://api.together.xyz",
    "apiKeyUrl": "https://api.together.xyz/settings/api-keys",
    "recommendedModels": [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    ],
    "docUrl": "https://api.together.xyz/settings/api-keys",
    "defaultBaseUrl": "https://api.together.xyz/v1",
    "envKey": "TOGETHER_API_KEY"
  },
  {
    "id": "commandgota",
    "name": "Command Code GOAT",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "aggregator",
    "websiteUrl": "https://commandcode.ai",
    "apiKeyUrl": "https://commandcode.ai",
    "recommendedModels": [
      "claude-sonnet-5",
      "gpt-6-luna",
      "deepseek/deepseek-v4.1-flash",
      "Qwen/Qwen3.8-Flash"
    ],
    "docUrl": "https://commandcode.ai/docs/provider",
    "defaultBaseUrl": "https://api.commandcode.ai/provider/v1",
    "envKey": "COMMANDCODE_API_KEY"
  },
  {
    "id": "ollama",
    "name": "Ollama (Local)",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "local",
    "websiteUrl": "https://ollama.com",
    "apiKeyUrl": "https://ollama.com",
    "recommendedModels": [
      "llama3.2"
    ],
    "docUrl": "https://ollama.com",
    "defaultBaseUrl": "http://localhost:11434/v1"
  },
  {
    "id": "lmstudio",
    "name": "LM Studio",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "local",
    "websiteUrl": "https://lmstudio.ai",
    "apiKeyUrl": "https://lmstudio.ai",
    "recommendedModels": [
      "local-model"
    ],
    "docUrl": "https://lmstudio.ai",
    "defaultBaseUrl": "http://localhost:1234/v1"
  },
  {
    "id": "vllm",
    "name": "vLLM",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "local",
    "websiteUrl": "https://docs.vllm.ai",
    "apiKeyUrl": "https://docs.vllm.ai",
    "recommendedModels": [
      "Qwen/Qwen3-8B"
    ],
    "docUrl": "https://docs.vllm.ai",
    "defaultBaseUrl": "http://localhost:8000/v1"
  },
  {
    "id": "custom-openai-compatible",
    "name": "Custom (OpenAI compatible)",
    "protocol": "openai-compatible",
    "npmPackage": "@ai-sdk/openai-compatible",
    "category": "aggregator",
    "websiteUrl": "https://ai-sdk.dev",
    "apiKeyUrl": "https://ai-sdk.dev/providers/openai-compatible-providers",
    "recommendedModels": [],
    "docUrl": "https://ai-sdk.dev/providers/openai-compatible-providers"
  }
]

const PRESETS_BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS_BY_ID.get(id)
}

/** The npm package that must be installed for a protocol to work. */
export function packageForProtocol(protocol: Protocol): string | undefined {
  return PROTOCOL_PACKAGES[protocol]
}
