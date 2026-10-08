import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    auto: "src/auto.ts",
    server: "src/server/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  dts: true,
  // ponytail: retain generated files; release battery validates the tarball whitelist.
  clean: false,
  treeshake: true,
})
