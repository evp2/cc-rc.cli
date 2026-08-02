import * as esbuild from "esbuild";
import { chmodSync } from "node:fs";

await esbuild.build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  // package.json declares "type": "module", so dist/index.js is loaded as ESM.
  // esbuild's platform:node default is cjs, which would fail at startup.
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  // Keep native/platform-specific packages external -- they must be installed
  // alongside the connector via npm install.
  external: ["@anthropic-ai/claude-agent-sdk", "qrcode-terminal"],
  banner: { js: "#!/usr/bin/env node" },
});

chmodSync("dist/index.js", 0o755);
