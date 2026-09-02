import { sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { studentPerformance } from "../db/schema.js";
import type { AIResponse } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";

/**
 * Analytics — UPSERTs student_performance when an AI response carried a
 * performance signal (§6.3).
 *
 * Note this accumulates data even for students with no active assignment —
 * intentional, and exactly the raw material AssignmentAdvisor needs (§9.1).
 */
export async function registerAnalytics(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.AIResponse, "analytics", async (msg: Message) => {
    const e = msg.payload as AIResponse;
    if (!e.performance) return;

    const p = e.performance;
    await db
      .insert(studentPerformance)
      .values({
        studentUserId: e.studentUserId,
        cbcNodeId: p.cbcNodeId,
        strand: p.strand,
        subStrand: p.subStrand,
        learningOutcome: p.learningOutcome,
        totalProblems: 1,
        correctCount: p.isCorrect ? 1 : 0,
        commonErrors: p.errorType ? [{ type: p.errorType, detail: p.errorDetail }] : [],
        lastActiveAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [studentPerformance.studentUserId, studentPerformance.cbcNodeId],
        set: {
          totalProblems: sql`${studentPerformance.totalProblems} + 1`,
          correctCount: sql`${studentPerformance.correctCount} + ${p.isCorrect ? 1 : 0}`,
          // TODO(phase-5): append to common_errors rather than replacing, and
          // cap the array so it stays a summary rather than a log.
          lastActiveAt: new Date(),
        },
      });
  });
}
