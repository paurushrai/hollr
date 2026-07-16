import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageJsonUrl = new URL("./package.json", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __KELBRIN_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
