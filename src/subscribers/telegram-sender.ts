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
  // Bot replies — always publish message.outbound even if Telegram is unlinked,
  // so MessageStore persists the bot reply and AppRealtimeBroadcaster pushes it
  // to connected Expo clients.
  await subscribeWithRetry(broker, Topics.AIResponse, "telegram-sender", async (msg: Message) => {
    const e = msg.payload as AIResponse;
    const chatId = await telegramChatIdFor(e.chatGroupId);

    let telegramMessageId: number | undefined;
    if (chatId !== null) {
      telegramMessageId = await sendMessage(chatId, e.text);
    }

    const outbound: MessageOutbound = {
      chatGroupId: e.chatGroupId,
      senderUserId: await botUserId(),
      senderRole: "bot",
      text: e.text,
      telegramMessageId,
    };
    await appBroker.publish({ topic: Topics.MessageOutbound, payload: outbound });
  });

  // Tutor messages sent from the Expo app — relay to Telegram and republish
  // with the telegramMessageId so MessageStore can stamp the row.
  await subscribeWithRetry(broker, Topics.MessageOutbound, "telegram-sender", async (msg: Message) => {
    const e = msg.payload as MessageOutbound;
    // Only relay the initial persisted tutor message; skip if telegramMessageId
    // is already set (that means this is a re-publish from ourselves).
    if (e.senderRole !== "tutor" || !e.persisted || e.telegramMessageId) return;

    const chatId = await telegramChatIdFor(e.chatGroupId);
    if (chatId === null) return;

    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, e.senderUserId))
      .limit(1);

    // The Bot API can only post as the bot itself — prefix the name for
    // attribution legibility to the student (§6.3).
    const telegramMessageId = await sendMessage(
      chatId,
      `${sender?.displayName ?? "Tutor"}: ${e.text}`,
    );

    // Republish so MessageStore records the Telegram-side message id.
    if (telegramMessageId) {
      await appBroker.publish({
        topic: Topics.MessageOutbound,
        payload: { ...e, telegramMessageId },
      });
    }
  });
}
