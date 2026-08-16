// The shebang is injected by build.mjs, not written here -- a second one in the
// source lands on line 2 of the bundle, where Node no longer strips it and it
// is a syntax error.
import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { loadConfig } from "../config";
import { qr, runForeground, start, status, stop } from "./commands";

const USAGE = `crc -- claude-remote-control connector

Usage:
  crc start   [--config <path>]   Start a connector in the background
  crc stop    [--config <path>] [--end]
                                  Stop the background connector. --end also
                                  ends the session, forcing a re-pair.
  crc status  [--config <path>]   Report connector and session health
  crc qr      [--config <path>]   Print the pairing URL and QR code (add
                                  --share for the Netlify share link instead)
  crc run     [--config <path>]   Run in the foreground (Ctrl-C to stop)

With no subcommand, crc runs in the foreground.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const known = ["start", "stop", "status", "qr", "run"];
  const subcommand = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  const rest = subcommand === argv[0] ? argv.slice(1) : argv;

  if (subcommand === "help" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (!known.includes(subcommand)) {
    throw new Error(`Unknown subcommand '${subcommand}'.\n\n${USAGE}`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string", short: "c", default: "./connector.config.json" },
      end: { type: "boolean", default: false },
      share: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const configPath = resolve(values.config as string);
  const config = loadConfig(configPath);

  switch (subcommand) {
    case "run":
      return runForeground(config);
    case "start":
      return start(config, configPath);
    case "stop":
      return stop(config, values.end as boolean);
    case "status":
      return status(config);
    case "qr":
      return qr(config, values.share as boolean);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
