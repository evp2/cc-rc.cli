import * as esbuild from "esbuild";
import { chmodSync } from "node:fs";
import { execSync } from "node:child_process";

// package.json's version is never bumped, so it can't tell two builds apart.
// The git SHA this was built from is the only signal that actually answers
// "which code is this connector running" -- e.g. for spotting a connector
// that's alive but still on an older build. "unknown" only if this ever runs
// outside a git checkout.
let connectorVersion = "unknown";
try {
  connectorVersion = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // leave "unknown"
}

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
  define: { __CONNECTOR_VERSION__: JSON.stringify(connectorVersion) },
});

chmodSync("dist/index.js", 0o755);
