import { eq } from "drizzle-orm";

import { broker as appBroker } from "../app-broker.js";
import { db } from "../db/client.js";
import { chatGroups, users } from "../db/schema.js";
import type { AIResponse, MessageOutbound } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { sendMessage } from "../services/telegram.js";
import { botUserId } from "../routes/students.js";

/**
 * TelegramSender — relays bot replies and app-sent tutor messages into the
 * Telegram group (§6.3).
 */
async function telegramChatIdFor(chatGroupId: string): Promise<number | null> {
  const [row] = await db
    .select({ telegramChatId: chatGroups.telegramChatId })
    .from(chatGroups)
    .where(eq(chatGroups.id, chatGroupId))
    .limit(1);
  return row?.telegramChatId ?? null;
}

export async function registerTelegramSender(broker: Broker): Promise<void> {
  // Bot replies.
  await subscribeWithRetry(broker, Topics.AIResponse, "telegram-sender", async (msg: Message) => {
    const e = msg.payload as AIResponse;
    const chatId = await telegramChatIdFor(e.chatGroupId);
    if (chatId === null) return; // Room not linked to Telegram yet — app-only.

    const telegramMessageId = await sendMessage(chatId, e.text);

    const outbound: MessageOutbound = {
      chatGroupId: e.chatGroupId,
      senderUserId: await botUserId(),
      senderRole: "bot",
      text: e.text,
      telegramMessageId,
    };
    await appBroker.publish({ topic: Topics.MessageOutbound, payload: outbound });
  });

  // Tutor messages sent from the Expo app.
  await subscribeWithRetry(broker, Topics.MessageOutbound, "telegram-sender", async (msg: Message) => {
    const e = msg.payload as MessageOutbound;
    if (e.senderRole !== "tutor" || !e.persisted) return;

    const chatId = await telegramChatIdFor(e.chatGroupId);
    if (chatId === null) return;

    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, e.senderUserId))
      .limit(1);

    // The Bot API can only post as the bot itself — it cannot impersonate the
    // tutor's Telegram identity — so prefix the name to keep attribution
    // legible to the student (§6.3).
    await sendMessage(chatId, `${sender?.displayName ?? "Tutor"}: ${e.text}`);
  });
}
