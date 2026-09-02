import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import type { MessageInbound, MessageOutbound } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { botUserId } from "../routes/students.js";

/**
 * MessageStore — INSERTs every inbound and outbound message (§6.3).
 *
 * The partial unique index on (chat_group_id, telegram_message_id) makes a
 * Telegram redelivery a no-op rather than a duplicate row, so this handler
 * does not need its own dedupe.
 */
export async function registerMessageStore(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.MessageInbound, "message-store", async (msg: Message) => {
    const e = msg.payload as MessageInbound;
    await db
      .insert(messages)
      .values({
        chatGroupId: e.chatGroupId,
        senderUserId: e.senderUserId,
        senderRole: e.senderRole,
        platform: e.platform,
        content: e.text,
        attachments: e.attachments,
        telegramMessageId: e.telegramMessageId ?? null,
      })
      .onConflictDoNothing();
  });

  await subscribeWithRetry(broker, Topics.MessageOutbound, "message-store", async (msg: Message) => {
    const e = msg.payload as MessageOutbound;

    // Messages sent from the app are written by the route before publishing,
    // so we only record the Telegram-side id here rather than re-inserting.
    if (e.persisted) {
      // TODO(phase-4): UPDATE messages SET telegram_message_id = e.telegramMessageId
      // for the row this event came from, once TelegramSender reports it back.
      return;
    }

    await db
      .insert(messages)
      .values({
        chatGroupId: e.chatGroupId,
        senderUserId: e.senderUserId || (await botUserId()),
        senderRole: e.senderRole,
        platform: "telegram",
        content: e.text,
        attachments: e.attachments ?? [],
        telegramMessageId: e.telegramMessageId ?? null,
      })
      .onConflictDoNothing();
  });
}
