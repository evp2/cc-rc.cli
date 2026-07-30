// The shebang is injected by build.mjs, not written here -- a second one in the
// source lands on line 2 of the bundle, where Node no longer strips it and it
// is a syntax error.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { loadConfig, type ConnectorConfig } from "./config";
import { printPairingQrCode } from "./qr";
import { RelayClient, SessionEndedError } from "./relayClient";
import { runConnector } from "./run";
import {
  ensureStateDir,
  isProcessAlive,
  liveConnector,
  logPath,
  readState,
  statePath,
  writeState,
} from "./state";

const USAGE = `crc -- claude-remote-control connector

Usage:
  crc start   [--config <path>]   Start a connector in the background
  crc stop    [--config <path>] [--end]
                                  Stop the background connector. --end also
                                  ends the session, forcing a re-pair.
  crc status  [--config <path>]   Report connector and session health
  crc qr      [--config <path>]   Re-print the pairing URL and QR code
  crc run     [--config <path>]   Run in the foreground (Ctrl-C to stop)

With no subcommand, crc runs in the foreground.
`;

// How long `crc start` waits for the detached process to publish a session.
const START_TIMEOUT_MS = 45_000;
const START_POLL_MS = 250;

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
      return qr(config);
  }
}

async function runForeground(config: ConnectorConfig): Promise<void> {
  const existing = liveConnector(config.projectDir);
  if (existing && existing.pid !== process.pid) {
    throw new Error(
      `A connector is already running for ${config.projectDir} (pid ${existing.pid}).\n` +
        `Stop it with 'crc stop' first, or check it with 'crc status'.`,
    );
  }

  const handle = await runConnector(config);
  console.log(
    `Session ${handle.sessionId} ${handle.resumed ? "resumed" : "created"} for ${config.projectDir}`,
  );
  console.log(`Open on your phone:\n  ${handle.phoneUrl}\n`);
  printPairingQrCode(handle.phoneUrl);
  console.log("");
  await handle.done;
}

/**
 * Spawns a detached copy of this process in `run` mode and waits for it to
 * publish a session to the state file.
 *
 * The state file is the handoff: the child's stdout goes to a log, so the
 * parent cannot scrape it for the phone URL the way a foreground run prints it.
 */
async function start(config: ConnectorConfig, configPath: string): Promise<void> {
  const existing = liveConnector(config.projectDir);
  if (existing) {
    console.log(`Already running for ${config.projectDir} (pid ${existing.pid}).`);
    console.log(`Open on your phone:\n  ${existing.phoneUrl}\n`);
    printPairingQrCode(existing.phoneUrl);
    return;
  }

  const entry = process.argv[1];
  if (!entry || entry.endsWith(".ts")) {
    throw new Error(
      "'crc start' needs the built entrypoint -- run 'npm run build' and start " +
        "via dist/index.js (or use 'crc run' to stay in the foreground).",
    );
  }

  ensureStateDir();
  const log = logPath(config.projectDir);
  const logFd = openSync(log, "a");
  const startedAt = Date.now();

  const child = spawn(process.execPath, [entry, "run", "--config", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: config.projectDir,
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  // Wait for the child to publish its own pid alongside a session, so a state
  // file left by a previous run can't be mistaken for this one's.
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(config.projectDir);
    if (state && state.pid === child.pid && Date.parse(state.startedAt) >= startedAt - 1000) {
      console.log(`Connector started for ${config.projectDir} (pid ${state.pid}).`);
      console.log(`Logging to ${log}`);
      console.log(`Open on your phone:\n  ${state.phoneUrl}\n`);
      printPairingQrCode(state.phoneUrl);
      return;
    }
    if (child.pid && !isProcessAlive(child.pid)) break;
    await sleep(START_POLL_MS);
  }

  throw new Error(
    `Connector did not start within ${Math.round(START_TIMEOUT_MS / 1000)}s.\n` +
      `Check the log for why:\n  ${log}\n\n${tailLog(log, 20)}`,
  );
}

async function stop(config: ConnectorConfig, end: boolean): Promise<void> {
  const state = readState(config.projectDir);
  if (!state) {
    console.log(`No connector state for ${config.projectDir}. Nothing to stop.`);
    return;
  }

  if (isProcessAlive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isProcessAlive(state.pid)) await sleep(200);
    console.log(
      isProcessAlive(state.pid)
        ? `Connector (pid ${state.pid}) did not exit within 15s; leaving it be.`
        : `Connector stopped (pid ${state.pid}).`,
    );
  } else {
    console.log(`No connector running for ${config.projectDir}.`);
  }

  if (!end) {
    console.log("Session left alive -- 'crc start' will resume it, no re-pair needed.");
    return;
  }

  // Ending is done here rather than in the connector so that a stop signal and
  // a deliberate end stay distinguishable: the connector never ends a session
  // just because it is exiting.
  try {
    const client = await RelayClient.resume(
      state.relayBaseUrl,
      state.sessionId,
      state.secret,
    );
    await client.end();
    console.log("Session ended. The phone will need to re-pair after the next start.");
  } catch (e) {
    if (e instanceof SessionEndedError) {
      console.log("Session had already ended.");
    } else {
      console.error("Failed to end the session:", (e as Error).message);
    }
  }
  writeState({ ...state, sdkSessionId: undefined, commandCursor: undefined, inFlight: undefined });
}

/**
 * Reports both halves of health, because they fail independently: the local
 * process may be alive while the relay has not heard from it, and the session
 * may be perfectly valid with no process running at all.
 */
async function status(config: ConnectorConfig): Promise<void> {
  const state = readState(config.projectDir);
  console.log(`project dir   ${config.projectDir}`);
  console.log(`state file    ${statePath(config.projectDir)}`);
  console.log(`log file      ${logPath(config.projectDir)}`);

  if (!state) {
    console.log(`process       not running (no state)`);
    console.log(`session       none -- 'crc start' will create one`);
    return;
  }

  const alive = isProcessAlive(state.pid);
  console.log(`process       ${alive ? `running (pid ${state.pid})` : `not running (last pid ${state.pid})`}`);
  console.log(`started at    ${state.startedAt}`);
  if (state.lastError) console.log(`last error    ${state.lastError}`);
  if (state.inFlight) {
    console.log(`in flight     ${state.inFlight.seq} (will be reported as interrupted, not re-run)`);
  }

  try {
    const client = await RelayClient.resume(
      state.relayBaseUrl,
      state.sessionId,
      state.secret,
    );
    const session = await client.getSession();
    const lastSeen = session.last_connector_seen_at;
    const ageMs = lastSeen ? Date.now() - Date.parse(lastSeen) : undefined;
    console.log(`session       ${state.sessionId} (alive)`);
    console.log(
      `relay sees    ${
        ageMs === undefined
          ? "never heard from this connector"
          : `${Math.round(ageMs / 1000)}s since last contact${ageMs < 15_000 ? "" : " -- the phone will treat it as unreachable"}`
      }`,
    );
    console.log(`phone url     ${state.phoneUrl}`);
  } catch (e) {
    if (e instanceof SessionEndedError) {
      console.log(`session       ${state.sessionId} (ended -- next start rotates, phone must re-pair)`);
    } else {
      console.log(`session       unknown -- relay unreachable: ${(e as Error).message}`);
    }
  }

  if (!alive) {
    console.log(`\nStart it with 'crc start'.`);
    const tail = tailLog(logPath(config.projectDir), 15);
    if (tail) console.log(`\nLast log lines:\n${tail}`);
  }
}

/**
 * Re-renders the pairing code for the *current* session. This is the lossless
 * path: a phone that pairs to a session it already had gets its whole
 * transcript back. Rotating is deliberately not offered here -- it is
 * `crc stop --end` followed by `crc start`.
 */
async function qr(config: ConnectorConfig): Promise<void> {
  const state = readState(config.projectDir);
  if (!state) {
    throw new Error(
      `No session for ${config.projectDir}. Start one with 'crc start'.`,
    );
  }

  try {
    await RelayClient.resume(state.relayBaseUrl, state.sessionId, state.secret);
  } catch (e) {
    if (e instanceof SessionEndedError) {
      throw new Error(
        `Session ${state.sessionId} has ended, so this code would not work.\n` +
          `Run 'crc stop --end' then 'crc start' for a new one -- note that ` +
          `discards the conversation.`,
      );
    }
    console.error(`Warning: could not verify the session: ${(e as Error).message}`);
  }

  if (!isProcessAlive(state.pid)) {
    console.log("Note: no connector is running, so the phone will stay blocked until 'crc start'.\n");
  }
  console.log(`Open on your phone:\n  ${state.phoneUrl}\n`);
  printPairingQrCode(state.phoneUrl);
}

function tailLog(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf-8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
