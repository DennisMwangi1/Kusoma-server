import { Bot } from "grammy";

import { env, isTelegramConfigured } from "../config/env.js";

/**
 * Telegram Bot API access — §7.
 *
 * The bot is constructed lazily so the server boots with TELEGRAM_BOT_TOKEN
 * unset (§16: a scaffold has to run on a laptop with half the integrations
 * unconfigured).
 */

let bot: Bot | null = null;

export function getBot(): Bot | null {
  if (!isTelegramConfigured()) return null;
  bot ??= new Bot(env.telegram.botToken);
  return bot;
}

/** Register the webhook once at startup. No-ops when unconfigured. */
export async function registerWebhook(): Promise<void> {
  const b = getBot();
  if (!b || !env.backendUrl) {
    console.warn("telegram: skipping setWebhook (bot token or BACKEND_URL unset)");
    return;
  }
  const url = `${env.backendUrl.replace(/\/$/, "")}/webhook/telegram`;
  await b.api.setWebhook(url, { allowed_updates: ["message"] });
  console.log(`telegram: webhook set to ${url}`);
}

/** The t.me deep link the tutor taps to create the group (§7). */
export const buildDeepLink = (studentUserId: string): string =>
  `https://t.me/${env.telegram.botUsername}?startgroup=${studentUserId}`;

export async function sendMessage(chatId: number, text: string): Promise<number | undefined> {
  const b = getBot();
  if (!b) return undefined;
  const sent = await b.api.sendMessage(chatId, text);
  return sent.message_id;
}

/**
 * Resolve a Telegram file_id to a temporary download URL.
 *
 * Used by services/attachments.ts to get bytes for Bedrock, which cannot take
 * a URL or a file id directly (§9.0).
 */
export async function getFileUrl(fileId: string): Promise<string | null> {
  const b = getBot();
  if (!b) return null;
  const file = await b.api.getFile(fileId);
  if (!file.file_path) return null;
  return `https://api.telegram.org/file/bot${env.telegram.botToken}/${file.file_path}`;
}
