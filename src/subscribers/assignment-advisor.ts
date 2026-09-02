import { and, desc, eq, gte, sql } from "drizzle-orm";

import { broker as appBroker } from "../app-broker.js";
import { db } from "../db/client.js";
import { assignments, chatGroups, studentPerformance, users } from "../db/schema.js";
import type { AssignmentSuggested, PerformanceRecorded } from "../events/types.js";
import { extractJsonObjectWithKey } from "../lib/json.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { AI_SETTINGS, complete } from "../services/bedrock.js";
import { searchCurriculum } from "../services/cbc-api-client.js";

/**
 * AssignmentAdvisor — §9.2. The AI proposes, the tutor approves.
 *
 *  1. Trigger on performance.recorded (after Analytics upserts), not on the
 *     raw ai.response — otherwise the threshold count can miss this event.
 *  2. Skip if a suggested row is already pending for this student.
 *  3. Threshold: at least 5 recorded problems since the last suggestion was
 *     made or dismissed for this student.
 *  4. Summarize accuracy per topic + common_errors + whether there is a
 *     currently active assignment, optionally seed searchCurriculum() with
 *     the error patterns so the suggestion lands on a real node.
 *  5. INSERT assignments { source: 'ai', status: 'suggested', rationale }.
 *  6. Publish assignment.suggested so Student Detail surfaces it.
 *
 * A suggested row changes NOTHING about what the AI scopes itself to — only
 * an 'active' assignment does that (§9.1). Nothing happens without the
 * tutor's action.
 */

const THRESHOLD = 5;

export async function registerAssignmentAdvisor(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.PerformanceRecorded, "assignment-advisor", async (msg: Message) => {
    const e = msg.payload as PerformanceRecorded;
    if (!e.performance) return;

    try {
      const [pending] = await db
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(eq(assignments.studentUserId, e.studentUserId), eq(assignments.status, "suggested")),
        )
        .limit(1);
      if (pending) return;

      // Count total problems across all topics for this student.
      const perfRows = await db
        .select()
        .from(studentPerformance)
        .where(eq(studentPerformance.studentUserId, e.studentUserId));

      const totalProblems = perfRows.reduce((sum, r) => sum + r.totalProblems, 0);

      // Find when the last suggestion was made or dismissed.
      const [lastSuggestion] = await db
        .select({ createdAt: assignments.createdAt })
        .from(assignments)
        .where(
          and(
            eq(assignments.studentUserId, e.studentUserId),
            eq(assignments.source, "ai"),
          ),
        )
        .orderBy(desc(assignments.createdAt))
        .limit(1);

      // Count problems since last suggestion (or all if none).
      let problemsSinceSuggestion = totalProblems;
      if (lastSuggestion) {
        const recent = await db
          .select({
            total: sql<number>`COALESCE(SUM(${studentPerformance.totalProblems}), 0)`,
          })
          .from(studentPerformance)
          .where(
            and(
              eq(studentPerformance.studentUserId, e.studentUserId),
              gte(studentPerformance.lastActiveAt, lastSuggestion.createdAt),
            ),
          );
        problemsSinceSuggestion = Number(recent[0]?.total ?? 0);
      }

      if (problemsSinceSuggestion < THRESHOLD) return;

      const [active] = await db
        .select({
          strand: assignments.strand,
          subStrand: assignments.subStrand,
          learningOutcome: assignments.learningOutcome,
        })
        .from(assignments)
        .where(
          and(eq(assignments.studentUserId, e.studentUserId), eq(assignments.status, "active")),
        )
        .limit(1);

      const activeLine = active
        ? `Currently active assignment: ${active.strand} > ${active.subStrand} > ${active.learningOutcome}.`
        : "There is no currently active assignment.";

      // Build a summary of the student's performance patterns.
      const totalCorrect = perfRows.reduce((sum, r) => sum + r.correctCount, 0);
      const accuracy = totalProblems > 0 ? Math.round((totalCorrect / totalProblems) * 100) : 0;

      const topicSummaries = perfRows.map((r) => ({
        topic: `${r.strand} > ${r.subStrand} > ${r.learningOutcome}`,
        problems: r.totalProblems,
        accuracy: r.totalProblems > 0 ? Math.round((r.correctCount / r.totalProblems) * 100) : 0,
        errors: r.commonErrors as Array<{ type: string; detail: string | null }>,
      }));

      // Gather error patterns for CBC search seeding.
      const errorPatterns = topicSummaries
        .flatMap((t) => t.errors.map((err) => err.detail ?? err.type))
        .filter(Boolean)
        .slice(0, 5);

      const [student] = await db
        .select({ grade: users.grade })
        .from(users)
        .where(eq(users.id, e.studentUserId))
        .limit(1);
      const grade = student?.grade ?? 7;

      // Optionally search CBC for grounded suggestion.
      const searchQuery = errorPatterns.join(", ") || "next learning outcome";
      const cbcResults = await searchCurriculum(searchQuery, grade, "mathematics");

      const cbcContext = cbcResults.length > 0
        ? "\n\nAvailable CBC curriculum nodes:\n" +
          cbcResults.map((n) =>
            `- [${n.id}] ${n.strand} > ${n.subStrand} > ${n.learningOutcome}`
          ).join("\n")
        : "";

      const prompt = [
        `Given this Grade ${grade} student's performance data:`,
        `Overall accuracy: ${accuracy}% across ${totalProblems} problems.`,
        activeLine,
        "",
        "Per-topic breakdown:",
        ...topicSummaries.map((t) =>
          `- ${t.topic}: ${t.accuracy}% accuracy (${t.problems} problems)` +
          (t.errors.length > 0
            ? `\n  Common errors: ${t.errors.map((err) => err.detail ?? err.type).join("; ")}`
            : "")
        ),
        cbcContext,
        "",
        "What specific CBC learning outcome should this student work on next, and why?",
        "Respond with ONLY a JSON object in this exact format:",
        '{"cbcNodeId": "uuid-from-list-above-or-best-guess", "strand": "...", "subStrand": "...", "learningOutcome": "...", "rationale": "one paragraph explaining why"}',
      ].join("\n");

      const { text: advisorText } = await complete({
        system: "You are a curriculum advisor for Kenyan CBC mathematics. Respond with ONLY the JSON object requested.",
        userText: prompt,
        settings: AI_SETTINGS.advisor,
      });

      const found = extractJsonObjectWithKey(advisorText, "cbcNodeId");
      if (!found) {
        console.warn("assignment-advisor: could not parse suggestion from model response");
        return;
      }

      const suggestion = JSON.parse(found.raw) as {
        cbcNodeId: string;
        strand: string;
        subStrand: string;
        learningOutcome: string;
        rationale: string;
      };

      const [group] = await db
        .select({ ownerUserId: chatGroups.ownerUserId })
        .from(chatGroups)
        .where(eq(chatGroups.studentUserId, e.studentUserId))
        .limit(1);

      if (!group) return;

      const [created] = await db
        .insert(assignments)
        .values({
          studentUserId: e.studentUserId,
          cbcNodeId: suggestion.cbcNodeId,
          strand: suggestion.strand,
          subStrand: suggestion.subStrand,
          learningOutcome: suggestion.learningOutcome,
          source: "ai",
          status: "suggested",
          rationale: suggestion.rationale,
        })
        .returning();

      if (!created) return;

      const event: AssignmentSuggested = {
        assignmentId: created.id,
        studentUserId: e.studentUserId,
        ownerUserId: group.ownerUserId,
        rationale: suggestion.rationale,
      };
      await appBroker.publish({ topic: Topics.AssignmentSuggested, payload: event });

      console.log(
        `assignment-advisor: suggested "${suggestion.learningOutcome}" for student ${e.studentUserId}`,
      );
    } catch (err) {
      console.error("assignment-advisor: failed", err);
    }
  });
}
