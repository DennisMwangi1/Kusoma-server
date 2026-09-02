import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";

import { broker } from "../app-broker.js";
import { db } from "../db/client.js";
import {
  chatGroups,
  roles,
  userRoles,
  users,
  type Attachment,
  type SenderRole,
} from "../db/schema.js";
import type { MessageInbound } from "../events/types.js";
import { Topics } from "../pkg/broker/broker.js";

export const telegramWebhookRouter = Router();

/**
 * Telegram webhook — §7.
 *
 * Always returns 200 quickly. Telegram retries on a slow or failing response,
 * and the partial unique index on (chat_group_id, telegram_message_id) makes
 * that retry idempotent for free.
 *
 * This handler no longer *creates* a chat_groups row. The room is created with
 * the student in POST /students; `/start {studentUserId}` only BINDS the
 * telegram_chat_id onto it. That removes Revision 1's ordering hazard, where a
 * room's existence depended on a third-party callback arriving.
 */

interface TelegramUpdate {
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width: number; height: number }>;
    document?: { file_id: string; mime_type?: string; file_name?: string };
    voice?: { file_id: string; mime_type?: string };
    video?: { file_id: string; mime_type?: string };
  };
}

/** Pull photo/document/voice/video off the update into the §5 shape. */
function extractAttachments(msg: NonNullable<TelegramUpdate["message"]>): Attachment[] {
  const out: Attachment[] = [];

  // Telegram sends several sizes; the last is the largest.
  const largest = msg.photo?.[msg.photo.length - 1];
  if (largest) {
    out.push({
      type: "image",
      telegramFileId: largest.file_id,
      width: largest.width,
      height: largest.height,
      caption: msg.caption,
    });
  }
  if (msg.document) {
    out.push({ type: "document", telegramFileId: msg.document.file_id, mimeType: msg.document.mime_type });
  }
  if (msg.voice) {
    out.push({ type: "voice", telegramFileId: msg.voice.file_id, mimeType: msg.voice.mime_type });
  }
  if (msg.video) {
    out.push({ type: "video", telegramFileId: msg.video.file_id, mimeType: msg.video.mime_type });
  }
  // NOTE: we store file ids only. Bytes are resolved on demand, and Bedrock
  // needs them base64-encoded rather than as ids or URLs (§9.0).
  return out;
}

/** Bind telegram_chat_id onto the room that already exists for this student. */
async function bindChat(studentUserId: string, chatId: number, title?: string): Promise<void> {
  await db
    .update(chatGroups)
    .set({ telegramChatId: chatId, ...(title && { title }) })
    .where(eq(chatGroups.studentUserId, studentUserId));
}

/**
 * Resolve the sender — ONE lookup against users, where Revision 1 had to try
 * `tutors` then `students`.
 */
async function resolveSender(
  telegramUserId: number,
): Promise<{ id: string; role: SenderRole } | null> {
  const [row] = await db
    .select({ id: users.id, roleKey: roles.key })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(users.telegramUserId, telegramUserId),
        inArray(roles.key, ["tutor", "guardian", "student"]),
      ),
    )
    .limit(1);

  return row ? { id: row.id, role: row.roleKey as SenderRole } : null;
}

telegramWebhookRouter.post("/telegram", async (req, res) => {
  // Acknowledge first; everything below is best-effort.
  res.status(200).json({ ok: true });

  try {
    const update = req.body as TelegramUpdate;
    const msg = update.message;
    if (!msg || msg.from?.is_bot) return;

    const text = msg.text ?? msg.caption ?? "";

    // /start {studentUserId} — bind the room, don't create one.
    const startMatch = /^\/start\s+([0-9a-f-]{36})$/i.exec(text.trim());
    if (startMatch) {
      await bindChat(startMatch[1]!, msg.chat.id, msg.chat.title);
      // TODO(phase-3): send the welcome message into the group.
      return;
    }

    const [group] = await db
      .select()
      .from(chatGroups)
      .where(eq(chatGroups.telegramChatId, msg.chat.id))
      .limit(1);
    if (!group) return; // Unlinked group — ignore.

    if (!msg.from) return;
    let sender = await resolveSender(msg.from.id);

    // Lazy capture (§7, §15): the first message from an unknown Telegram
    // account in a linked group claims the student slot if it is still empty.
    if (!sender) {
      const [student] = await db
        .select({ id: users.id, telegramUserId: users.telegramUserId })
        .from(users)
        .where(eq(users.id, group.studentUserId))
        .limit(1);

      if (student && student.telegramUserId === null) {
        await db
          .update(users)
          .set({ telegramUserId: msg.from.id, updatedAt: new Date() })
          .where(eq(users.id, student.id));
        sender = { id: student.id, role: "student" };
      }
    }

    if (!sender) return; // Unmatched — ignore, per §7.

    const event: MessageInbound = {
      chatGroupId: group.id,
      studentUserId: group.studentUserId,
      ownerUserId: group.ownerUserId,
      senderUserId: sender.id,
      senderRole: sender.role === "bot" ? "student" : sender.role,
      platform: "telegram",
      text,
      attachments: extractAttachments(msg),
      telegramChatId: msg.chat.id,
      telegramMessageId: msg.message_id,
      timestamp: new Date(),
    };

    await broker.publish({ topic: Topics.MessageInbound, payload: event });
  } catch (err) {
    console.error("telegram: webhook handling failed", err);
  }
});
