import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { userRelationships, users } from "../db/schema.js";
import { phonesMatch } from "../lib/phone.js";

export async function releaseTelegramIfHolder(
  userId: string,
  telegramUserId: number,
): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ telegramUserId: null, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.telegramUserId, telegramUserId)))
    .returning({ id: users.id });
  return Boolean(row);
}

/**
 * Stamp the student with this Telegram account.
 *
 * Telegram is the student's classroom. If this id was previously stamped on
 * the tutor (the old /start-claims-tutor behaviour), steal it so the student
 * can speak and the AI will actually answer.
 */
export async function claimStudentSlot(opts: {
  studentUserId: string;
  ownerUserId: string;
  telegramUserId: number;
}): Promise<boolean> {
  const [student] = await db
    .select({ id: users.id, telegramUserId: users.telegramUserId })
    .from(users)
    .where(eq(users.id, opts.studentUserId))
    .limit(1);
  if (!student) return false;
  if (student.telegramUserId === opts.telegramUserId) return true;
  if (student.telegramUserId !== null) return false;

  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramUserId, opts.telegramUserId))
    .limit(1);

  try {
    return await db.transaction(async (tx) => {
      if (holder && holder.id === opts.ownerUserId) {
        await tx
          .update(users)
          .set({ telegramUserId: null, updatedAt: new Date() })
          .where(eq(users.id, opts.ownerUserId));
      } else if (holder && holder.id !== opts.studentUserId) {
        return false;
      }

      const [claimed] = await tx
        .update(users)
        .set({ telegramUserId: opts.telegramUserId, updatedAt: new Date() })
        .where(and(eq(users.id, opts.studentUserId), isNull(users.telegramUserId)))
        .returning({ id: users.id });
      return Boolean(claimed);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

export type GuardianRow = {
  id: string;
  displayName: string;
  phone: string | null;
  telegramUserId: number | null;
};

export async function guardiansOf(studentUserId: string): Promise<GuardianRow[]> {
  return db
    .select({
      id: users.id,
      displayName: users.displayName,
      phone: users.phone,
      telegramUserId: users.telegramUserId,
    })
    .from(users)
    .innerJoin(userRelationships, eq(userRelationships.fromUserId, users.id))
    .where(
      and(
        eq(userRelationships.toUserId, studentUserId),
        eq(userRelationships.relationship, "guardian_of"),
      ),
    );
}

function isUniqueViolation(err: unknown): boolean {
  const codes: string[] = [];
  for (let cur: unknown = err; cur && typeof cur === "object"; ) {
    if ("code" in cur && typeof (cur as { code: unknown }).code === "string") {
      codes.push((cur as { code: string }).code);
    }
    cur = "cause" in cur ? (cur as { cause: unknown }).cause : undefined;
  }
  return codes.includes("23505");
}

export type ClaimGuardianResult =
  | { ok: true; guardian: GuardianRow; releasedStudent: boolean }
  | {
      ok: false;
      reason: "no_guardians" | "no_match" | "already_other_telegram" | "taken";
    };

/**
 * Bind this Telegram account to the guardian whose phone matches the shared
 * contact. Prefers the guardian row when student and parent share a number.
 *
 * If this Telegram id was already stamped on the student (parent spoke first),
 * that stamp is released so the unique constraint can move it to the guardian.
 */
export async function claimGuardianByPhone(opts: {
  studentUserId: string;
  telegramUserId: number;
  contactPhone: string;
}): Promise<ClaimGuardianResult> {
  const guardians = await guardiansOf(opts.studentUserId);
  if (guardians.length === 0) return { ok: false, reason: "no_guardians" };

  const already = guardians.find((g) => g.telegramUserId === opts.telegramUserId);
  if (already) return { ok: true, guardian: already, releasedStudent: false };

  const match = guardians.find((g) => phonesMatch(g.phone, opts.contactPhone));
  if (!match) return { ok: false, reason: "no_match" };
  if (match.telegramUserId !== null) return { ok: false, reason: "already_other_telegram" };

  try {
    const releasedStudent = await db.transaction(async (tx) => {
      const [released] = await tx
        .update(users)
        .set({ telegramUserId: null, updatedAt: new Date() })
        .where(
          and(eq(users.id, opts.studentUserId), eq(users.telegramUserId, opts.telegramUserId)),
        )
        .returning({ id: users.id });

      const [claimed] = await tx
        .update(users)
        .set({ telegramUserId: opts.telegramUserId, updatedAt: new Date() })
        .where(and(eq(users.id, match.id), isNull(users.telegramUserId)))
        .returning({ id: users.id });

      if (!claimed) {
        throw new Error("guardian slot taken");
      }
      return Boolean(released);
    });

    return { ok: true, guardian: { ...match, telegramUserId: opts.telegramUserId }, releasedStudent };
  } catch (err) {
    if (isUniqueViolation(err) || (err instanceof Error && err.message === "guardian slot taken")) {
      return { ok: false, reason: "taken" };
    }
    throw err;
  }
}
