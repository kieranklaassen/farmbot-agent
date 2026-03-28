import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  shims: false,
  banner: ({ format }) => {
    if (format === "esm") {
      return {};
    }
    return {};
  },
});
