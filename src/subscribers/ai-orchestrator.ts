import { and, desc, eq } from "drizzle-orm";

import { broker as appBroker } from "../app-broker.js";
import { db } from "../db/client.js";
import { assignments, messages, users } from "../db/schema.js";
import type { AIRequest, AIResponse, PerformanceSignal } from "../events/types.js";
import { extractJsonObjectWithKey } from "../lib/json.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { toImageBlocks } from "../services/attachments.js";
import { AI_SETTINGS, complete } from "../services/bedrock.js";
import { searchContent, searchCurriculum } from "../services/cbc-api-client.js";

/**
 * AIOrchestrator — §6.3, §9.
 *
 * Full §9.1 prompt assembly: optional assignment scope, CBC curriculum +
 * content grounding, last 10 messages, image instruction, trailing
 * performance-JSON contract. Vision blocks resolved via toImageBlocks().
 *
 * Assignment context is OPTIONAL by design — a student with zero assignments
 * must get a sensible answer, forever (§1, §15).
 */

/** Extract trailing {"performance": ...} JSON block from AI text. */
function extractPerformance(text: string): { cleanText: string; performance?: PerformanceSignal } {
  const found = extractJsonObjectWithKey(text, "performance");
  if (!found) return { cleanText: text };

  try {
    const parsed = JSON.parse(found.raw) as { performance: PerformanceSignal };
    const p = parsed.performance;
    if (p && typeof p.cbcNodeId === "string" && typeof p.isCorrect === "boolean") {
      return {
        cleanText: (text.slice(0, found.start) + text.slice(found.start + found.raw.length)).trimEnd(),
        performance: p,
      };
    }
  } catch {
    // Malformed JSON — ignore, show the full text to the student.
  }
  return { cleanText: text };
}

async function buildSystemPrompt(opts: {
  grade: number | null;
  assignment: { strand: string; subStrand: string; learningOutcome: string } | null;
  chatGroupId: string;
  studentText: string;
  hasImages: boolean;
}): Promise<string> {
  const gradeText = opts.grade ? `Grade ${opts.grade}` : "school-age";
  const gradeNum = opts.grade ?? 7;

  // Assignment scope (optional)
  let scope: string;
  if (opts.assignment) {
    scope =
      `The student is working on ${opts.assignment.strand} > ${opts.assignment.subStrand}. ` +
      `Their current learning outcome: ${opts.assignment.learningOutcome}.`;
  } else {
    scope =
      "No specific topic has been assigned yet — help with whatever " +
      "the student brings, and infer the likely strand/sub-strand from their question " +
      "so you can still ground your answer in real curriculum content below.";
  }

  // CBC curriculum + content grounding (§9.1) — degrade silently
  const query = opts.assignment?.learningOutcome ?? opts.studentText;
  const subject = "mathematics";
  const [curriculumResults, contentResults] = await Promise.all([
    searchCurriculum(query, gradeNum, subject),
    searchContent(query, gradeNum, subject),
  ]);

  let curriculumContext = "";
  if (curriculumResults.length > 0) {
    curriculumContext =
      "\n\nCURRICULUM CONTEXT:\n" +
      curriculumResults
        .map(
          (n) =>
            `- ${n.strand} > ${n.subStrand} > ${n.learningOutcome}` +
            (n.teachingApproach ? `\n  Teaching approach: ${n.teachingApproach}` : "") +
            (n.suggestedActivities?.length
              ? `\n  Suggested activities: ${n.suggestedActivities.join("; ")}`
              : ""),
        )
        .join("\n");
  }

  let contentContext = "";
  if (contentResults.length > 0) {
    contentContext =
      "\n\nREAL EXAMPLES (from past papers and worked examples):\n" +
      contentResults
        .map(
          (c) =>
            `Q: ${c.question}` +
            (c.answer ? `\nA: ${c.answer}` : "") +
            (c.solution ? `\nSolution: ${c.solution}` : ""),
        )
        .join("\n\n");
  }

  // Prior turns only — the current inbound is passed as userText. Fetch 11 so
  // we still have 10 after stripping the current message when MessageStore won
  // the inbound race.
  const history = await db
    .select({
      senderRole: messages.senderRole,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.chatGroupId, opts.chatGroupId))
    .orderBy(desc(messages.createdAt))
    .limit(11);

  const chronological = history.reverse();
  const last = chronological[chronological.length - 1];
  if (last?.senderRole === "student" && last.content === opts.studentText) {
    chronological.pop();
  }
  const prior = chronological.slice(-10);

  let conversationHistory = "";
  if (prior.length > 0) {
    conversationHistory =
      "\n\nCONVERSATION HISTORY:\n" +
      prior.map((m) => `[${m.senderRole}]: ${m.content}`).join("\n");
  }

  const imageInstruction = opts.hasImages
    ? "\n\nThe student attached an image. Describe what you see in the image and use " +
      "it to inform your answer — e.g. read the handwritten homework problem, or check " +
      "the student's working for errors."
    : "";

  return [
    `You are a tutor helping a ${gradeText} student in Kenya.`,
    scope,
    curriculumContext,
    contentContext,
    conversationHistory,
    imageInstruction,
    "",
    "RULES:",
    "- Guide the student to the answer; do not give it directly.",
    "- Use the real examples above to ground your explanations where relevant.",
    opts.assignment
      ? "- If the student's question is well outside the assigned topic, briefly help but redirect to the assigned topic."
      : "- Follow whatever the student brings.",
    "- Keep language simple. Mix English and Swahili naturally if the student does.",
    "- When evaluating an answer, write your explanation first, then a JSON block at the very end:",
    '  {"performance": {"cbcNodeId": "...", "strand": "...", "subStrand": "...",',
    '  "learningOutcome": "...", "isCorrect": true/false,',
    '  "errorType": "conceptual"|"computational"|"misread"|null, "errorDetail": "..."}}',
    "  Omit the JSON block entirely if the message isn't an answer attempt.",
  ].join("\n");
}

export async function registerAIOrchestrator(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.AIRequest, "ai-orchestrator", async (msg: Message) => {
    const e = msg.payload as AIRequest;

    const [student] = await db
      .select({ grade: users.grade })
      .from(users)
      .where(eq(users.id, e.studentUserId))
      .limit(1);

    // Query the ACTIVE assignment specifically, not just any row.
    const [activeAssignment] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.studentUserId, e.studentUserId), eq(assignments.status, "active")))
      .limit(1);

    const active = activeAssignment ?? null;

    // Resolve image attachments to base64 vision blocks (§9.0)
    const imageBlocks = await toImageBlocks(e.attachments);

    const system = await buildSystemPrompt({
      grade: student?.grade ?? null,
      assignment: active,
      chatGroupId: e.chatGroupId,
      studentText: e.text,
      hasImages: imageBlocks.length > 0,
    });

    const { text } = await complete({
      system,
      userText: e.text,
      imageBlocks,
      settings: AI_SETTINGS.chat,
    });

    // Extract trailing performance JSON, strip it from student-visible text.
    const { cleanText, performance } = extractPerformance(text);

    const response: AIResponse = {
      chatGroupId: e.chatGroupId,
      studentUserId: e.studentUserId,
      text: cleanText,
      performance,
    };

    await appBroker.publish({ topic: Topics.AIResponse, payload: response });
  });
}
