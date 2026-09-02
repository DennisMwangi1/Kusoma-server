import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { userRelationships, type RelationshipKind } from "../db/schema.js";
import { forbidden } from "../lib/errors.js";
import type { AuthedUser } from "./authenticate.js";

/**
 * The piece that replaces Revision 1's two scoping paths (§8.1).
 *
 * One query, no role branch: "is the caller related to this student, and how?"
 * A tutor gets 'tutor_of' rows, a guardian gets 'guardian_of' rows, and a user
 * who is both (their own child) gets both — which the old two-table design
 * could not express at all.
 *
 * Read access is this check. Write access is this check *plus*
 * requirePermission(...) on the route. Nothing else.
 */
export async function scopeStudent(
  user: AuthedUser,
  studentUserId: string,
): Promise<RelationshipKind[]> {
  const rows = await db
    .select({ relationship: userRelationships.relationship })
    .from(userRelationships)
    .where(
      and(
        eq(userRelationships.fromUserId, user.id),
        eq(userRelationships.toUserId, studentUserId),
      ),
    );

  if (rows.length === 0) {
    // Deliberately 403 and not 404: distinguishing "no such student" from
    // "not yours" would leak the existence of other tutors' rosters.
    throw forbidden("Not related to this student");
  }
  return rows.map((r) => r.relationship as RelationshipKind);
}

/**
 * Every student the caller may see, in one query. Backs GET /students and
 * GET /dashboard/summary — which is why the dashboard degrades naturally to
 * one student for a guardian rather than 403-ing.
 */
export async function listRelatedStudentIds(user: AuthedUser): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: userRelationships.toUserId })
    .from(userRelationships)
    .where(eq(userRelationships.fromUserId, user.id));
  return rows.map((r) => r.id);
}

/** True when the caller owns the student as a tutor (not merely guards them). */
export const isTutorOf = (kinds: RelationshipKind[]): boolean => kinds.includes("tutor_of");
