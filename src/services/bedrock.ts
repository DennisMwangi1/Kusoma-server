import Anthropic from "@anthropic-ai/sdk";

import { env } from "../config/env.js";
import type { ImageBlock } from "./attachments.js";

/**
 * Anthropic API client — replaces the Bedrock client from the original spec.
 *
 * The Anthropic API supports URL image sources and structured outputs, but we
 * keep the base64 vision path and trailing-JSON parse for consistency with the
 * rest of the codebase (attachments.ts already resolves to base64). Request
 * settings follow §9.0: adaptive thinking plus output_config.effort.
 */
export const anthropic = new Anthropic({ apiKey: env.anthropic.apiKey });

export const MODEL = env.anthropic.modelId;

/**
 * Vision still goes through base64 — attachments.ts resolves both Telegram
 * file_ids and URLs to bytes before they reach the model. The Anthropic API
 * also caps request payload at ~20 MB for vision.
 */
export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

export type Effort = "low" | "medium" | "high";

export interface CompletionSettings {
  max_tokens: number;
  effort: Effort;
}

/** Per-path request settings. Tunable; these are the starting points (§9.0). */
export const AI_SETTINGS = {
  /** Short tutoring turns, and a student is waiting on the reply. */
  chat: { max_tokens: 2048, effort: "low" } satisfies CompletionSettings,
  /** One call, nobody waiting, quality matters. */
  advisor: { max_tokens: 4096, effort: "high" } satisfies CompletionSettings,
} as const;

export interface CompletionResult {
  text: string;
  stopReason: string | null;
}

/**
 * One Anthropic API call. Supports an optional list of image blocks alongside
 * the user text so the model can see homework photos.
 */
export async function complete(opts: {
  system: string;
  userText: string;
  imageBlocks?: ImageBlock[];
  settings?: CompletionSettings;
}): Promise<CompletionResult> {
  const settings = opts.settings ?? AI_SETTINGS.chat;

  const contentBlocks: Array<{ type: "text"; text: string } | ImageBlock> = [];

  if (opts.imageBlocks?.length) {
    for (const img of opts.imageBlocks) contentBlocks.push(img);
  }
  contentBlocks.push({ type: "text", text: opts.userText });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: settings.max_tokens,
    system: opts.system,
    thinking: { type: "adaptive" },
    output_config: { effort: settings.effort },
    messages: [{ role: "user", content: contentBlocks }],
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
export async function verifyAnthropicAccess(): Promise<void> {
  await complete({
    system: "Reply with the single word: ok",
    userText: "ping",
    settings: { max_tokens: 1024, effort: "low" },
  });
}
