import { defineConfig } from "vitest/config"
import core from "./packages/mik/vitest.config"

// ponytail: root gate reuses the core timeout policy; dashboard uses node:test.
export default defineConfig({
  test: { ...core.test, include: ["packages/mik/test/**/*.test.ts"] },
})
