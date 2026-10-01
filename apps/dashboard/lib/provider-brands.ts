export interface BrandStyle {
  id: string
  label: string
  shortTag: string
  color: string
  bgSoft: string
  borderSoft: string
}

export function getProviderBrand(id: string, presetId?: string, protocol?: string): BrandStyle {
  const key = `${presetId || ""} ${id || ""} ${protocol || ""}`.toLowerCase()
  if (key.includes("deepseek")) {
    return {
      id: "deepseek",
      label: "DeepSeek",
      shortTag: "DS",
      color: "#1e60d5",
      bgSoft: "rgba(30, 96, 213, 0.12)",
      borderSoft: "rgba(30, 96, 213, 0.28)",
    }
  }
  if (key.includes("openai") || key.includes("gpt")) {
    return {
      id: "openai",
      label: "OpenAI",
      shortTag: "OAI",
      color: "#10a37f",
      bgSoft: "rgba(16, 163, 127, 0.12)",
      borderSoft: "rgba(16, 163, 127, 0.28)",
    }
  }
  if (key.includes("anthropic") || key.includes("claude")) {
    return {
      id: "anthropic",
      label: "Anthropic",
      shortTag: "CLD",
      color: "#d97706",
      bgSoft: "rgba(217, 119, 6, 0.12)",
      borderSoft: "rgba(217, 119, 6, 0.28)",
    }
  }
  if (key.includes("google") || key.includes("gemini")) {
    return {
      id: "google",
      label: "Gemini",
      shortTag: "GEM",
      color: "#1a73e8",
      bgSoft: "rgba(26, 115, 232, 0.12)",
      borderSoft: "rgba(26, 115, 232, 0.28)",
    }
  }
  if (key.includes("openrouter")) {
    return {
      id: "openrouter",
      label: "OpenRouter",
      shortTag: "OR",
      color: "#6366f1",
      bgSoft: "rgba(99, 102, 241, 0.12)",
      borderSoft: "rgba(99, 102, 241, 0.28)",
    }
  }
  if (key.includes("ollama")) {
    return {
      id: "ollama",
      label: "Ollama",
      shortTag: "OLM",
      color: "#374151",
      bgSoft: "rgba(55, 65, 81, 0.12)",
      borderSoft: "rgba(55, 65, 81, 0.28)",
    }
  }
  if (key.includes("moonshot")) {
    return {
      id: "moonshotai",
      label: "Moonshot",
      shortTag: "KIMI",
      color: "#0284c7",
      bgSoft: "rgba(2, 132, 199, 0.12)",
      borderSoft: "rgba(2, 132, 199, 0.28)",
    }
  }
  if (key.includes("xai") || key.includes("grok")) {
    return {
      id: "xai",
      label: "xAI",
      shortTag: "xAI",
      color: "#0f172a",
      bgSoft: "rgba(15, 23, 42, 0.12)",
      borderSoft: "rgba(15, 23, 42, 0.28)",
    }
  }
  const fallbackTag = id.slice(0, 2).toUpperCase() || "LLM"
  return {
    id: "custom",
    label: id || "Custom",
    shortTag: fallbackTag,
    color: "#64748b",
    bgSoft: "rgba(100, 116, 139, 0.12)",
    borderSoft: "rgba(100, 116, 139, 0.28)",
  }
}
