import { eq } from "drizzle-orm";

import { broker as appBroker } from "../app-broker.js";
import { db } from "../db/client.js";
import { assignments, users } from "../db/schema.js";
import type { AIRequest, AIResponse } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { AI_SETTINGS, complete } from "../services/bedrock.js";

/**
 * AIOrchestrator — §6.3, §9.
 *
 * SCAFFOLD (§16). What is real: the subscription, the active-assignment
 * lookup, and one working Bedrock call. What is deliberately NOT here yet:
 * the full §9.1 prompt (curriculum + content grounding, last-10-message
 * history), base64 vision blocks, and the trailing-performance-JSON parse.
 *
 * Assignment context is OPTIONAL by design — a student with zero assignments
 * must get a sensible answer, forever, if that is how their tutor uses Kusoma
 * (§1, §15).
 */

function buildSystemPrompt(opts: {
  grade: number | null;
  assignment: { strand: string; subStrand: string; learningOutcome: string } | null;
}): string {
  const gradeText = opts.grade ? `Grade ${opts.grade}` : "school-age";
  const scope = opts.assignment
    ? `The student is working on ${opts.assignment.strand} > ${opts.assignment.subStrand}. ` +
      `Their current learning outcome: ${opts.assignment.learningOutcome}.`
    : "No specific topic has been assigned yet — help with whatever the student brings.";

  // TODO(phase-5): the full §9.1 prompt — CURRICULUM CONTEXT and REAL EXAMPLES
  // from cbc-api-client search, CONVERSATION HISTORY (last 10 messages), the
  // image-attachment instruction, and the trailing performance-JSON contract.
  return [
    `You are a tutor helping a ${gradeText} student in Kenya.`,
    scope,
    "",
    "RULES:",
    "- Guide the student to the answer; do not give it directly.",
    "- Keep language simple. Mix English and Swahili naturally if the student does.",
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

    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.studentUserId, e.studentUserId))
      .limit(1);

    const active = assignment?.status === "active" ? assignment : null;

    // TODO(phase-5): resolve e.attachments to base64 image blocks via
    // services/attachments.ts and pass them as vision content. Bedrock will
    // not accept a URL or a Telegram file id (§9.0).
    const { text } = await complete({
      system: buildSystemPrompt({ grade: student?.grade ?? null, assignment: active }),
      userText: e.text,
      settings: AI_SETTINGS.chat,
    });

    // TODO(phase-5): extract the trailing {"performance": {...}} block from
    // `text` (Bedrock has no structured outputs, §9.0), strip it from what the
    // student sees, and set it on `performance` below.
    const response: AIResponse = {
      chatGroupId: e.chatGroupId,
      studentUserId: e.studentUserId,
      text,
    };

    await appBroker.publish({ topic: Topics.AIResponse, payload: response });
  });
}
