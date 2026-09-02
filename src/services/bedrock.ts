import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import { env } from "../config/env.js";

/**
 * AWS Bedrock client — §9.0.
 *
 * Credentials and region resolve through the standard AWS precedence:
 * constructor args -> AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_SESSION_TOKEN / AWS_REGION -> the AWS config file and credential chain
 * (SSO, assumed roles, ECS task role, IMDS). There is no Anthropic API key.
 */
export const bedrock = new AnthropicBedrockMantle({ awsRegion: env.bedrock.region });

/**
 * Bedrock model ids carry an `anthropic.` prefix. Kept in an env var because
 * Opus 5 access is granted per AWS account on Bedrock, while Sonnet 5 and
 * Haiku 4.5 are open to all — so a model change is config, not code.
 */
export const MODEL = env.bedrock.modelId;

/**
 * Three Bedrock constraints that shape everything below (§9.0):
 *
 *  1. Vision is base64-only — no URL image sources, no Files API. Both of the
 *     attachment shapes in §5 must be resolved to bytes server-side first.
 *     See services/attachments.ts.
 *  2. No structured outputs — `output_config.format` is unavailable, so the
 *     trailing-JSON-block parse in §9.1 is the mechanism, not a workaround.
 *  3. No server-side tools and no Message Batches. Nothing here needs them.
 *
 * Bedrock also caps a request payload at 20 MB, which you will hit on
 * multi-photo homework long before any token limit.
 */
export const BEDROCK_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

/** Per-path request settings (§9.0). Tunable; these are the starting points. */
export const AI_SETTINGS = {
  /** Short tutoring turns, and a student is waiting on the reply. */
  chat: { max_tokens: 2048, effort: "low" },
  /** One call, nobody waiting, quality matters. */
  advisor: { max_tokens: 4096, effort: "high" },
} as const;

export interface CompletionResult {
  text: string;
  stopReason: string | null;
}

/**
 * The one real Bedrock call in the scaffold (§16). Prompt assembly (§9.1),
 * vision blocks, and performance-JSON extraction are deliberately NOT here
 * yet — this exists so Phase 5 can prove credentials, region, and model access
 * resolve before anything is built on top of them.
 */
export async function complete(opts: {
  system: string;
  userText: string;
  settings?: { max_tokens: number; effort: string };
}): Promise<CompletionResult> {
  const settings = opts.settings ?? AI_SETTINGS.chat;

  const response = await bedrock.messages.create({
    model: MODEL,
    max_tokens: settings.max_tokens,
    system: opts.system,
    thinking: { type: "adaptive" },
    output_config: { effort: settings.effort as "low" | "medium" | "high" },
    messages: [{ role: "user", content: opts.userText }],
  });

  const text = response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  return { text, stopReason: response.stop_reason ?? null };
}

/**
 * Startup smoke check. Called only when explicitly requested — it costs money,
 * so it is not wired into boot.
 */
export async function verifyBedrockAccess(): Promise<void> {
  await complete({
    system: "Reply with the single word: ok",
    userText: "ping",
    settings: { max_tokens: 16, effort: "low" },
  });
}
