import { eq, sql } from "drizzle-orm";

import { broker as appBroker } from "../app-broker.js";
import { db } from "../db/client.js";
import { studentPerformance } from "../db/schema.js";
import type { AIResponse, PerformanceRecorded } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";

/** Cap the common_errors array at this many entries so it stays a summary. */
const MAX_COMMON_ERRORS = 20;

/**
 * Analytics — UPSERTs student_performance when an AI response carried a
 * performance signal (§6.3).
 *
 * Note this accumulates data even for students with no active assignment —
 * intentional, and exactly the raw material AssignmentAdvisor needs (§9.1).
 *
 * After a successful upsert, publishes performance.recorded so AssignmentAdvisor
 * runs against the updated row rather than racing this handler (§9.2).
 */
export async function registerAnalytics(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.AIResponse, "analytics", async (msg: Message) => {
    const e = msg.payload as AIResponse;
    if (!e.performance) return;

    const p = e.performance;
    const newError = p.errorType ? { type: p.errorType, detail: p.errorDetail ?? null } : null;

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
        commonErrors: newError ? [newError] : [],
        lastActiveAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [studentPerformance.studentUserId, studentPerformance.cbcNodeId],
        set: {
          totalProblems: sql`${studentPerformance.totalProblems} + 1`,
          correctCount: sql`${studentPerformance.correctCount} + ${p.isCorrect ? 1 : 0}`,
          // Append to common_errors and keep the last MAX_COMMON_ERRORS entries.
          ...(newError
            ? {
                commonErrors: sql`(
                  SELECT jsonb_agg(elem)
                  FROM (
                    SELECT elem
                    FROM jsonb_array_elements(
                      ${studentPerformance.commonErrors} || ${JSON.stringify(newError)}::jsonb
                    ) AS elem
                    ORDER BY 1 DESC
                    LIMIT ${MAX_COMMON_ERRORS}
                  ) sub
                )`,
              }
            : {}),
          lastActiveAt: new Date(),
        },
      });

    const recorded: PerformanceRecorded = {
      chatGroupId: e.chatGroupId,
      studentUserId: e.studentUserId,
      performance: p,
    };
    await appBroker.publish({ topic: Topics.PerformanceRecorded, payload: recorded });
  });
}
