import { Router } from "express";
import { desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { chatGroups, chatParticipants, messages, users } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";

export const chatsRouter = Router();
chatsRouter.use(authenticate);

/**
 * GET /chats — every chat group the caller participates in, newest activity first.
 *
 * This is the in-app mirror of the tutor's Telegram groups: one row per room,
 * with the Telegram title when the group is linked.
 */
chatsRouter.get("/", requirePermission("messages:read"), async (req, res, next) => {
  try {
    const memberships = await db
      .select({
        id: chatGroups.id,
        title: chatGroups.title,
        studentUserId: chatGroups.studentUserId,
        telegramChatId: chatGroups.telegramChatId,
        createdAt: chatGroups.createdAt,
        studentName: users.displayName,
        studentGrade: users.grade,
      })
      .from(chatParticipants)
      .innerJoin(chatGroups, eq(chatParticipants.chatGroupId, chatGroups.id))
      .innerJoin(users, eq(users.id, chatGroups.studentUserId))
      .where(eq(chatParticipants.userId, req.user!.id));

    const groupIds = memberships.map((g) => g.id);
    const latestByGroup = new Map<
      string,
      {
        content: string;
        senderRole: string;
        senderName: string;
        createdAt: Date;
      }
    >();

    if (groupIds.length > 0) {
      const rows = await db
        .select({
          chatGroupId: messages.chatGroupId,
          content: messages.content,
          senderRole: messages.senderRole,
          senderName: users.displayName,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderUserId))
        .where(inArray(messages.chatGroupId, groupIds))
        .orderBy(desc(messages.createdAt));

      for (const row of rows) {
        if (latestByGroup.has(row.chatGroupId)) continue;
        latestByGroup.set(row.chatGroupId, {
          content: row.content,
          senderRole: row.senderRole,
          senderName: row.senderName,
          createdAt: row.createdAt,
        });
      }
    }

    const iso = (value: Date | string) =>
      value instanceof Date ? value.toISOString() : String(value);

    const data = memberships
      .map((g) => {
        const last = latestByGroup.get(g.id) ?? null;
        return {
          id: g.id,
          title: g.title || g.studentName,
          studentUserId: g.studentUserId,
          studentName: g.studentName,
          studentGrade: g.studentGrade,
          telegramLinked: g.telegramChatId !== null,
          lastMessage: last
            ? {
                content: last.content,
                senderRole: last.senderRole,
                senderName: last.senderName,
                createdAt: iso(last.createdAt),
              }
            : null,
          createdAt: iso(g.createdAt),
        };
      })
      .sort((a, b) => {
        const aTime = a.lastMessage?.createdAt ?? a.createdAt;
        const bTime = b.lastMessage?.createdAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      })
      .map(({ createdAt: _createdAt, ...row }) => row);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});
