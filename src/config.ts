import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ProviderConfig } from "./provider";

/**
 * The connector always runs with permissions bypassed, and this is not
 * configurable.
 *
 * Every other mode can raise a permission prompt, and a headless connector has
 * nobody to answer one: the phone has no approval round-trip, so a prompted turn
 * would hang until the session aged out.
 *
 * Every turn therefore has unrestricted power over the project directory. That
 * exposure is bounded elsewhere instead: a turn only ever starts while the
 * developer's machine is reachable and someone is there to watch it begin.
 */
export const PERMISSION_MODE = "bypassPermissions" as const;

export interface InactivityCompactConfig {
  afterMinutes: number;
}

/** Below this, a misconfigured value would fire Auto-compact on almost every Turn instead of after a genuine idle stretch. */
export const MIN_INACTIVITY_COMPACT_MINUTES = 5;

export interface ConnectorConfig {
  relayBaseUrl: string;
  createSecret: string;
  projectDir: string;
  provider: ProviderConfig;
  /**
   * Absent means the feature is off. When set, the connector submits its own
   * `/compact` Command after this many minutes of no real Command completing --
   * safe to run unattended specifically because `/compact` is a Local command
   * that never reaches the model or the working tree.
   */
  inactivityCompact?: InactivityCompactConfig;
}

export function loadConfig(path: string): ConnectorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to read config at ${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config at ${path} must be a JSON object`);
  }
  const c = raw as Record<string, unknown>;

  const relayBaseUrl = requireString(c, "relayBaseUrl");
  const createSecret = requireString(c, "createSecret");
  const projectDir = typeof c.projectDir === "string" && c.projectDir.length > 0
    ? c.projectDir
    : process.cwd();
  // Accepted for backwards compatibility with existing config files, but it no
  // longer selects anything -- say so rather than letting someone believe a
  // stricter mode is in force.
  if (typeof c.permissionMode === "string" && c.permissionMode !== PERMISSION_MODE) {
    console.warn(
      `Ignoring 'permissionMode': "${c.permissionMode}" -- the connector always runs ` +
        `with ${PERMISSION_MODE}. Remove the field from your config to silence this.`,
    );
  }

  const providerRaw = c.provider;
  if (typeof providerRaw !== "object" || providerRaw === null) {
    throw new Error("'provider' is required and must be an object");
  }
  const p = providerRaw as Record<string, unknown>;
  const providerType = requireString(p, "type");

  let provider: ProviderConfig;
  if (providerType === "anthropic") {
    provider = {
      type: "anthropic",
      apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : undefined,
    };
  } else if (providerType === "bedrock") {
    // Both optional -- buildProviderEnv falls back to the ambient AWS_REGION /
    // ANTHROPIC_MODEL, so `{"type":"bedrock"}` alone is a valid config.
    provider = {
      type: "bedrock",
      region: optionalString(p, "region"),
      model: optionalString(p, "model"),
    };
  } else {
    throw new Error("'provider.type' must be 'anthropic' or 'bedrock'");
  }

  let inactivityCompact: InactivityCompactConfig | undefined;
  if (c.inactivityCompact !== undefined) {
    if (typeof c.inactivityCompact !== "object" || c.inactivityCompact === null) {
      throw new Error("'inactivityCompact' must be an object if present");
    }
    const ic = c.inactivityCompact as Record<string, unknown>;
    const afterMinutes = ic.afterMinutes;
    if (
      typeof afterMinutes !== "number" ||
      !Number.isFinite(afterMinutes) ||
      afterMinutes < MIN_INACTIVITY_COMPACT_MINUTES
    ) {
      throw new Error(
        `'inactivityCompact.afterMinutes' must be a number >= ${MIN_INACTIVITY_COMPACT_MINUTES} if present`,
      );
    }
    inactivityCompact = { afterMinutes };
  }

  return {
    relayBaseUrl: relayBaseUrl.replace(/\/+$/, ""),
    createSecret,
    projectDir: resolve(projectDir),
    provider,
    ...(inactivityCompact ? { inactivityCompact } : {}),
  };
}

/** Reads an optional string field. An empty string is treated as absent. */
function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`'${key}' must be a string if present`);
  }
  return value.length > 0 ? value : undefined;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return value;
}
