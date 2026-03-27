import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
});
