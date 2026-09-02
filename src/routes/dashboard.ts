import { Router } from "express";
import { inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { studentPerformance, users } from "../db/schema.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { listRelatedStudentIds } from "../middleware/scope-student.js";

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /dashboard/summary
 *
 * Computed across whatever students the caller is related to — so it degrades
 * naturally to one student for a guardian rather than 403-ing (§8.2). Same
 * handler, no role branch.
 */
dashboardRouter.get("/summary", requirePermission("dashboard:read"), async (req, res, next) => {
  try {
    const ids = await listRelatedStudentIds(req.user!);
    if (ids.length === 0) {
      return res.json({ activeStudents: 0, engagedToday: 0, totalProblems: 0, avgAccuracy: 0 });
    }

    const studentRows = await db.select().from(users).where(inArray(users.id, ids));
    const perf = await db
      .select()
      .from(studentPerformance)
      .where(inArray(studentPerformance.studentUserId, ids));

    const cutoff = Date.now() - DAY_MS;
    const engaged = new Set(
      perf.filter((p) => p.lastActiveAt && p.lastActiveAt.getTime() >= cutoff).map((p) => p.studentUserId),
    );

    const totalProblems = perf.reduce((sum, p) => sum + p.totalProblems, 0);
    const totalCorrect = perf.reduce((sum, p) => sum + p.correctCount, 0);

    res.json({
      activeStudents: studentRows.filter((s) => s.isActive).length,
      engagedToday: engaged.size,
      totalProblems,
      avgAccuracy: totalProblems > 0 ? Math.round((totalCorrect / totalProblems) * 100) : 0,
    });
  } catch (err) {
    next(err);
  }
});
