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
import { claimGuardianByPhone, claimStudentSlot, guardiansOf, releaseTelegramIfHolder } from "../services/telegram-identity.js";
import { botUsername, requestParentContact, sendMessage } from "../services/telegram.js";
import { parseStudentUuid } from "../lib/uuid.js";

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
 *
 * Identity in a linked group:
 *   guardian — /iamparent, then a shared contact matching their login phone
 *   student  — first unknown speaker, or anyone added to the group after bind
 *   tutor    — the app account; we do NOT stamp them from /start (that was
 *              tagging the person who pasted the command as tutor, so the AI
 *              never answered)
 *
 * /start is only honoured in groups/supergroups. A private /start means the
 * startgroup deep link fell through to a DM — we tell them to make a group.
 */

interface TelegramContact {
  phone_number: string;
  first_name: string;
  user_id?: number;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    from?: TelegramUser;
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
    contact?: TelegramContact;
    new_chat_members?: TelegramUser[];
    photo?: Array<{ file_id: string; width: number; height: number }>;
    document?: { file_id: string; mime_type?: string; file_name?: string };
    voice?: { file_id: string; mime_type?: string };
    video?: { file_id: string; mime_type?: string };
  };
  chat_member?: {
    chat: { id: number; type: string; title?: string };
    new_chat_member: { user: TelegramUser; status: string };
  };
}

const PARENT_CLAIM_TTL_MS = 10 * 60 * 1000;
/** telegramUserId → expiry + which student. Lets the parent share contact in the group or in a DM. */
const pendingParentClaims = new Map<number, { studentUserId: string; groupChatId: number; expires: number }>();

function markPendingParent(telegramUserId: number, studentUserId: string, groupChatId: number): void {
  pendingParentClaims.set(telegramUserId, {
    studentUserId,
    groupChatId,
    expires: Date.now() + PARENT_CLAIM_TTL_MS,
  });
}

function takePendingParent(telegramUserId: number): { studentUserId: string; groupChatId: number } | null {
  const row = pendingParentClaims.get(telegramUserId);
  pendingParentClaims.delete(telegramUserId);
  if (!row || row.expires <= Date.now()) return null;
  return { studentUserId: row.studentUserId, groupChatId: row.groupChatId };
}

function isPendingParent(telegramUserId: number): boolean {
  const row = pendingParentClaims.get(telegramUserId);
  if (!row) return false;
  if (row.expires <= Date.now()) {
    pendingParentClaims.delete(telegramUserId);
    return false;
  }
  return true;
}

function commandName(text: string): string {
  const raw = text.split(/\s/)[0]!.toLowerCase();
  return raw.replace(/@\S+$/, "");
}

function isGroupChat(type: string): boolean {
  return type === "group" || type === "supergroup";
}

function parseStartStudentId(text: string): string | null {
  const match = /^\/start(?:@\S+)?(?:\s+([0-9a-f-]{32,36}))?$/i.exec(text.trim());
  if (!match?.[1]) return null;
  return parseStudentUuid(match[1]);
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

async function tryClaimStudent(
  group: { studentUserId: string; ownerUserId: string },
  telegramUserId: number,
): Promise<{ id: string; role: SenderRole } | null> {
  const sender = await resolveSender(telegramUserId);
  if (sender?.role === "guardian") return sender;
  if (sender?.role === "student" && sender.id === group.studentUserId) return sender;

  try {
    const claimed = await claimStudentSlot({
      studentUserId: group.studentUserId,
      ownerUserId: group.ownerUserId,
      telegramUserId,
    });
    if (claimed) return { id: group.studentUserId, role: "student" };
  } catch (err) {
    console.error("telegram: could not claim student", err);
  }
  return sender;
}

async function welcomeStudent(chatId: number, studentUserId: string): Promise<void> {
  const [student] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, studentUserId))
    .limit(1);
  const name = student?.displayName ?? "student";
  await sendMessage(
    chatId,
    `👋 Welcome to Kusoma! This group is now linked for ${name}.\n\n` +
      `Have ${name} send a question here (or add them to the group) and I'll help.\n\n` +
      `Parents: type /iamparent and share your Kusoma number before chatting.\n\n` +
      `Type /help for available commands.`,
  );
}

async function handleIamParent(chatId: number, fromId: number): Promise<void> {
  const [group] = await db
    .select()
    .from(chatGroups)
    .where(eq(chatGroups.telegramChatId, chatId))
    .limit(1);
  if (!group) {
    if (isPendingParent(fromId)) {
      await requestParentContact(chatId);
      return;
    }
    await sendMessage(
      chatId,
      "Run /iamparent in the student's Telegram group first. You can then share your number here.",
    );
    return;
  }

  const sender = await resolveSender(fromId);
  if (sender?.role === "tutor") {
    await sendMessage(
      chatId,
      "This Telegram account is already linked as the tutor. " +
        "A parent uses a different Telegram account — even if you share a phone number — " +
        "or just opens the Kusoma app.",
    );
    return;
  }

  const guardians = await guardiansOf(group.studentUserId);
  if (guardians.length === 0) {
    await sendMessage(
      chatId,
      "No parent has been added for this student yet. Ask the tutor to add one in the Kusoma app, then type /iamparent again.",
    );
    return;
  }

  const already = guardians.find((g) => g.telegramUserId === fromId);
  if (already) {
    await sendMessage(
      chatId,
      `You're already linked as ${already.displayName}'s parent. The bot won't auto-reply to you.`,
    );
    return;
  }

  markPendingParent(fromId, group.studentUserId, chatId);
  await requestParentContact(chatId);
}

async function handleParentContact(
  chatId: number,
  fromId: number,
  contact: TelegramContact,
): Promise<void> {
  if (contact.user_id !== fromId) {
    await sendMessage(
      chatId,
      "Please share your own number using /iamparent — not someone else's contact.",
      { reply_markup: { remove_keyboard: true } },
    );
    return;
  }

  const pending = takePendingParent(fromId);
  if (!pending) {
    await sendMessage(
      chatId,
      "Type /iamparent in the student's group first, then share your number. That's how we tell parent and student apart when they share a phone.",
      { reply_markup: { remove_keyboard: true } },
    );
    return;
  }

  const sender = await resolveSender(fromId);
  if (sender?.role === "tutor") {
    await sendMessage(
      chatId,
      "This Telegram account is already linked as the tutor, so it can't also be the parent.",
      { reply_markup: { remove_keyboard: true } },
    );
    return;
  }

  const result = await claimGuardianByPhone({
    studentUserId: pending.studentUserId,
    telegramUserId: fromId,
    contactPhone: contact.phone_number,
  });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      no_guardians:
        "No parent has been added for this student yet. Ask the tutor to add one in the Kusoma app.",
      no_match:
        "That number doesn't match a parent on this student. Check the phone on the Kusoma parent account, or ask the tutor to add you.",
      already_other_telegram:
        "A parent with that number is already linked to a different Telegram account.",
      taken: "This Telegram account is already linked to another Kusoma user.",
    };
    await sendMessage(chatId, messages[result.reason], { reply_markup: { remove_keyboard: true } });
    return;
  }

  const [student] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, pending.studentUserId))
    .limit(1);
  const studentName = student?.displayName ?? "the student";
  const recovered = result.releasedStudent
    ? `\n\nThis Telegram was previously tagged as the student — that's cleared. ${studentName} should send questions from their own Telegram account.`
    : `\n\n${studentName} should send questions from their own Telegram account. One Telegram login cannot be both parent and student.`;

  const linked =
    `You're linked as ${studentName}'s parent. The bot won't auto-reply to you — you can watch in the group or in the Kusoma app.${recovered}`;
  await sendMessage(chatId, linked, { reply_markup: { remove_keyboard: true } });
  if (chatId !== pending.groupChatId) {
    await sendMessage(pending.groupChatId, linked);
  }
}

telegramWebhookRouter.post("/telegram", async (req, res) => {
  // Acknowledge first; everything below is best-effort.
  res.status(200).json({ ok: true });

  try {
    const update = req.body as TelegramUpdate;

    // Someone joined a linked group — claim them as the student if the slot is free.
    const memberUpdate = update.chat_member;
    if (memberUpdate && isGroupChat(memberUpdate.chat.type)) {
      const joined = memberUpdate.new_chat_member;
      const status = joined.status;
      if (
        joined.user &&
        !joined.user.is_bot &&
        (status === "member" || status === "administrator" || status === "restricted")
      ) {
        const [group] = await db
          .select()
          .from(chatGroups)
          .where(eq(chatGroups.telegramChatId, memberUpdate.chat.id))
          .limit(1);
        if (group) await tryClaimStudent(group, joined.user.id);
      }
      return;
    }

    const msg = update.message;
    if (!msg || msg.from?.is_bot) return;

    const text = msg.text ?? msg.caption ?? "";
    const groupChat = isGroupChat(msg.chat.type);

    // /start {studentUserId} — bind the room, don't create one.
    // Only groups. A private /start means startgroup opened a DM instead of
    // a group picker — binding that chat made the tutor the only speaker and
    // the AI never fired.
    const startStudentId = parseStartStudentId(text);
    if (text.trim().toLowerCase().startsWith("/start") && startStudentId) {
      if (!groupChat) {
        const bot = botUsername();
        await sendMessage(
          msg.chat.id,
          `This needs a Telegram *group*, not a private chat.\n\n` +
            `1. Open Telegram → New Group\n` +
            `2. Add @${bot} and the student\n` +
            `3. Send this in the group:\n\n` +
            `/start ${startStudentId}`,
        );
        return;
      }

      await bindChat(startStudentId, msg.chat.id, msg.chat.title);

      const [group] = await db
        .select()
        .from(chatGroups)
        .where(eq(chatGroups.studentUserId, startStudentId))
        .limit(1);

      if (group && msg.from?.id) {
        // Undo the old "whoever sent /start is the tutor" stamp so this
        // account (or the next person added) can be the student.
        try {
          await releaseTelegramIfHolder(group.ownerUserId, msg.from.id);
        } catch (err) {
          console.error("telegram: could not release tutor stamp", err);
        }

        if (msg.new_chat_members?.length) {
          for (const member of msg.new_chat_members) {
            if (!member.is_bot) await tryClaimStudent(group, member.id);
          }
        }
      }

      await welcomeStudent(msg.chat.id, startStudentId);
      return;
    }

    // Private /start after /iamparent in the group — show the share-number button.
    if (/^\/start(?:@\S+)?$/i.test(text.trim()) && msg.from?.id && isPendingParent(msg.from.id)) {
      await requestParentContact(msg.chat.id);
      return;
    }

    // Convenience commands — handled before the Router fires (§7).
    if (text.startsWith("/")) {
      const cmd = commandName(text);
      if (cmd === "/help") {
        await sendMessage(
          msg.chat.id,
          "📚 *Kusoma Bot Commands*\n\n" +
            "/status — Check student progress\n" +
            "/assign — Manage assignments (use the Kusoma app)\n" +
            "/iamparent — Link as this student's parent (share your Kusoma number)\n" +
            "/help — Show this help message\n\n" +
            "Students: just send your questions and I'll help!\n" +
            "Parents: /iamparent first so you aren't linked as the student.",
        );
        return;
      }
      if (cmd === "/status") {
        const [group] = await db
          .select()
          .from(chatGroups)
          .where(eq(chatGroups.telegramChatId, msg.chat.id))
          .limit(1);
        if (group) {
          const [student] = await db
            .select({ displayName: users.displayName, grade: users.grade })
            .from(users)
            .where(eq(users.id, group.studentUserId))
            .limit(1);
          await sendMessage(
            msg.chat.id,
            `📊 *Student:* ${student?.displayName ?? "Unknown"}\n` +
              `*Grade:* ${student?.grade ?? "N/A"}\n\n` +
              `Open the Kusoma app for detailed performance data.`,
          );
        }
        return;
      }
      if (cmd === "/assign") {
        await sendMessage(
          msg.chat.id,
          "📘 To assign or change a topic, open the Kusoma app → Student Detail → Change Topic.",
        );
        return;
      }
      if (cmd === "/iamparent") {
        if (msg.from?.id) await handleIamParent(msg.chat.id, msg.from.id);
        return;
      }
    }

    if (msg.contact && msg.from?.id) {
      await handleParentContact(msg.chat.id, msg.from.id, msg.contact);
      return;
    }

    if (msg.new_chat_members?.length) {
      const [joinGroup] = await db
        .select()
        .from(chatGroups)
        .where(eq(chatGroups.telegramChatId, msg.chat.id))
        .limit(1);
      if (joinGroup) {
        for (const member of msg.new_chat_members) {
          if (!member.is_bot) await tryClaimStudent(joinGroup, member.id);
        }
      }
      if (!text.trim() && !msg.photo && !msg.document && !msg.voice && !msg.video) return;
    }

    const [group] = await db
      .select()
      .from(chatGroups)
      .where(eq(chatGroups.telegramChatId, msg.chat.id))
      .limit(1);
    if (!group) return; // Unlinked group — ignore.

    if (!msg.from) return;
    let sender = await resolveSender(msg.from.id);

    if (!sender && isPendingParent(msg.from.id)) {
      await sendMessage(
        msg.chat.id,
        "Tap Share my Kusoma number so we can link you as the parent. We won't treat this account as the student while that's pending.",
      );
      return;
    }

    // Unknown (or previously tagged as tutor from an old /start) → student.
    if (!sender || sender.role === "tutor") {
      const claimed = await tryClaimStudent(group, msg.from.id);
      if (claimed) sender = claimed;
    }

    if (!sender) return; // Unmatched — ignore, per §7.

    const attachments = extractAttachments(msg);
    if (!text.trim() && attachments.length === 0) return;

    const event: MessageInbound = {
      chatGroupId: group.id,
      studentUserId: group.studentUserId,
      ownerUserId: group.ownerUserId,
      senderUserId: sender.id,
      senderRole: sender.role === "bot" ? "student" : sender.role,
      platform: "telegram",
      text,
      attachments,
      telegramChatId: msg.chat.id,
      telegramMessageId: msg.message_id,
      timestamp: new Date(),
    };

    await broker.publish({ topic: Topics.MessageInbound, payload: event });
  } catch (err) {
    console.error("telegram: webhook handling failed", err);
  }
});
