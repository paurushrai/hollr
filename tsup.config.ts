import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const packageJsonUrl = new URL("./package.json", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  define: {
    __KELBRIN_VERSION__: JSON.stringify(packageJson.version),
  },
});
