import type { AIResponse } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";

/**
 * AssignmentAdvisor — §9.2. The AI proposes, the tutor approves.
 *
 * SCAFFOLD (§16): subscribed and registered, body deliberately unimplemented.
 * The shape below is the decision that has already been made, so Phase 5 fills
 * in logic rather than re-deciding architecture:
 *
 *  1. Trigger on ai.response — no scheduler, no job queue, just another
 *     handler on the same topic Analytics listens to.
 *  2. Threshold: at least 5 recorded problems since the last suggestion was
 *     made or dismissed for this student.
 *  3. Summarize accuracy per topic + common_errors, optionally seed
 *     cbc-api-client.searchCurriculum() with the error patterns so the
 *     suggestion lands on a real node rather than a free-text guess.
 *  4. INSERT assignments { source: 'ai', status: 'suggested', rationale }.
 *  5. Publish assignment.suggested so Student Detail surfaces it.
 *
 * Critically, a suggested row changes NOTHING about what the AI scopes itself
 * to — only an 'active' assignment does that (§9.1). Nothing happens without
 * the tutor's action; that is what keeps them the decision-maker.
 */
export async function registerAssignmentAdvisor(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.AIResponse, "assignment-advisor", async (msg: Message) => {
    const e = msg.payload as AIResponse;
    if (!e.performance) return;

    // TODO(phase-5): implement steps 2-5 above.
    void e;
  });
}
