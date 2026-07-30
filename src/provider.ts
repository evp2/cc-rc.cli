export interface AnthropicProviderConfig {
  type: "anthropic";
  apiKeyEnv?: string;
}

export interface BedrockProviderConfig {
  type: "bedrock";
  /** Optional -- falls back to the ambient AWS_REGION/AWS_DEFAULT_REGION. */
  region?: string;
  /** Optional -- falls back to the ambient ANTHROPIC_MODEL, else the SDK default. */
  model?: string;
}

export type ProviderConfig = AnthropicProviderConfig | BedrockProviderConfig;

/**
 * Builds the env object passed to each `query()` call. The Agent SDK
 * *replaces* the subprocess environment entirely with whatever `options.env`
 * contains -- it does not merge with `process.env` -- so every branch here
 * must start from a full copy of the current environment.
 */
export function buildProviderEnv(
  config: ProviderConfig,
): Record<string, string | undefined> {
  const env = { ...process.env };

  if (config.type === "anthropic") {
    // If an API key is available, pass it through explicitly. Otherwise fall
    // back to the ambient `claude` CLI's own stored login (subscription
    // OAuth via `claude login`/`claude setup-token`) -- this is the common
    // case on a personal dev machine and needs no key at all.
    const apiKeyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    return env;
  }

  // Bedrock: AWS credentials are resolved from the ambient environment (AWS_PROFILE,
  // SSO, static keys, or AWS_BEARER_TOKEN_BEDROCK) via the normal AWS SDK default
  // chain -- the connector never manages credentials itself, same as the `claude`
  // CLI's own Bedrock support. `model` should be an application inference
  // profile ARN.
  //
  // Both `region` and `model` are optional: an explicit value wins, otherwise the
  // ambient environment is left in place so a shell already configured for Bedrock
  // (AWS_REGION/AWS_DEFAULT_REGION, ANTHROPIC_MODEL) works with a bare
  // `{"type":"bedrock"}` config.
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  if (config.region) env.AWS_REGION = config.region;
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  // The SDK has a sane default model, but no default region -- without one every
  // call fails deep inside the subprocess with an opaque error, so say so here.
  if (!env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
    console.warn(
      "provider.type is 'bedrock' but no region is set -- add 'region' to the " +
        "provider config or set AWS_REGION in the environment.",
    );
  }
  return env;
}
