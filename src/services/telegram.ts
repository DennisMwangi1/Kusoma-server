import { Bot, Keyboard } from "grammy";

import { env, isTelegramConfigured } from "../config/env.js";
import { telegramStartPayload } from "../lib/uuid.js";

/**
 * Telegram Bot API access — §7.
 *
 * The bot is constructed lazily so the server boots with TELEGRAM_BOT_TOKEN
 * unset (§16: a scaffold has to run on a laptop with half the integrations
 * unconfigured).
 */

/** Rights requested when adding the bot via startgroup — needed to see joins. */
export const TELEGRAM_STARTGROUP_ADMIN =
  "invite_users+pin_messages+delete_messages+restrict_members";

export function botUsername(): string {
  return env.telegram.botUsername.replace(/^@/, "");
}

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
  await b.api.setWebhook(url, {
    allowed_updates: ["message", "chat_member", "my_chat_member"],
  });
  console.log(`telegram: webhook set to ${url}`);
  console.warn(
    "telegram: BotFather → Groups: Enable, Privacy: Disable — otherwise student messages never reach the bot",
  );
}

/**
 * Deep link that asks Telegram to add the bot to a group (picker includes
 * New Group on mobile). Payload is the student UUID without hyphens —
 * startgroup is base64url-ish and dashed UUIDs often open a blank picker or
 * a private chat instead.
 */
export const buildDeepLink = (studentUserId: string): string => {
  const bot = botUsername();
  const payload = telegramStartPayload(studentUserId);
  return `https://t.me/${bot}?startgroup=${payload}&admin=${TELEGRAM_STARTGROUP_ADMIN}`;
};

export const buildNativeDeepLink = (studentUserId: string): string => {
  const bot = botUsername();
  const payload = telegramStartPayload(studentUserId);
  return `tg://resolve?domain=${bot}&startgroup=${payload}&admin=${TELEGRAM_STARTGROUP_ADMIN}`;
};

export async function sendMessage(
  chatId: number,
  text: string,
  extra?: { reply_markup?: { remove_keyboard: true } },
): Promise<number | undefined> {
  const b = getBot();
  if (!b) return undefined;
  const sent = await b.api.sendMessage(chatId, text, extra);
  return sent.message_id;
}

/** One-time keyboard so the parent shares *their* Telegram contact (includes user_id). */
export async function requestParentContact(chatId: number): Promise<void> {
  const b = getBot();
  if (!b) return;
  const text =
    "To link as this student's parent, share the phone number on your Kusoma parent account.\n\n" +
    "In the group: paperclip → Contact → pick yourself.\n" +
    "Or message me privately — Telegram only shows a Share-number button in a private chat.";
  const keyboard = new Keyboard()
    .requestContact("Share my Kusoma number")
    .resized()
    .oneTime();
  try {
    await b.api.sendMessage(chatId, text, { reply_markup: keyboard });
  } catch (err) {
    console.warn("telegram: request-contact keyboard failed (normal in groups)", err);
    await b.api.sendMessage(chatId, text);
  }
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
