import { Router } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { broker } from "../app-broker.js";
import { db } from "../db/client.js";
import { chatGroups, chatParticipants, messages, users } from "../db/schema.js";
import type { MessageOutbound } from "../events/types.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { scopeStudent } from "../middleware/scope-student.js";
import { Topics } from "../pkg/broker/broker.js";

export const messagesRouter = Router({ mergeParams: true });
messagesRouter.use(authenticate);

const sendBody = z.object({
  text: z.string().min(1).max(4000),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
});

async function groupForStudent(studentUserId: string) {
  const [group] = await db
    .select()
    .from(chatGroups)
    .where(eq(chatGroups.studentUserId, studentUserId))
    .limit(1);
  if (!group) throw notFound("Chat group not found for this student");
  return group;
}

/** GET /students/:id/messages?before=&limit= — paginated history. */
messagesRouter.get("/", requirePermission("messages:read"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, req.params.id!);
    const group = await groupForStudent(req.params.id!);

    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const before = req.query.before ? new Date(String(req.query.before)) : null;

    const rows = await db
      .select({
        id: messages.id,
        chatGroupId: messages.chatGroupId,
        senderUserId: messages.senderUserId,
        senderRole: messages.senderRole,
        senderName: users.displayName,
        platform: messages.platform,
        content: messages.content,
        attachments: messages.attachments,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderUserId))
      .where(
        before
          ? and(eq(messages.chatGroupId, group.id), lt(messages.createdAt, before))
          : eq(messages.chatGroupId, group.id),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    // Oldest-first for the chat UI; the query is newest-first for the index.
    res.json({ data: rows.reverse(), chatGroupId: group.id });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /students/:id/messages — send as the caller.
 *
 * Checks chat_participants.can_post as well as the permission, so a guardian
 * is blocked at the room level *and* at the route level (§15).
 */
messagesRouter.post("/", requirePermission("messages:send"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, req.params.id!);
    const group = await groupForStudent(req.params.id!);

    const [participant] = await db
      .select({ canPost: chatParticipants.canPost })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatGroupId, group.id),
          eq(chatParticipants.userId, req.user!.id),
        ),
      )
      .limit(1);

    if (!participant) throw forbidden("Not a participant in this chat");
    if (!participant.canPost) throw forbidden("Read-only participant");

    const parsed = sendBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");

    const [row] = await db
      .insert(messages)
      .values({
        chatGroupId: group.id,
        senderUserId: req.user!.id,
        senderRole: "tutor",
        platform: "app",
        content: parsed.data.text,
        attachments: parsed.data.attachments ?? [],
      })
      .returning();

    // Already persisted, so MessageStore skips it; TelegramSender relays it
    // and AppRealtimeBroadcaster fans it out to other connected clients.
    const event: MessageOutbound = {
      chatGroupId: group.id,
      senderUserId: req.user!.id,
      senderRole: "tutor",
      text: parsed.data.text,
      persisted: true,
    };
    await broker.publish({ topic: Topics.MessageOutbound, payload: event });

    res.status(201).json({ message: row });
  } catch (err) {
    next(err);
  }
});
