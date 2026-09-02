import { broker as appBroker } from "../app-broker.js";
import type { AIRequest, MessageInbound } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";

/**
 * Router — decides what gets an AI reply (§6.3).
 *
 * Only student messages trigger the AI. Tutor and guardian messages are stored
 * but never answered, on either platform — "the bot never auto-responds to
 * tutors" is enforced here, not baked into the prompt (§15).
 */
export async function registerRouter(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.MessageInbound, "router", async (msg: Message) => {
    const e = msg.payload as MessageInbound;
    if (e.senderRole !== "student") return;

    const request: AIRequest = {
      chatGroupId: e.chatGroupId,
      studentUserId: e.studentUserId,
      ownerUserId: e.ownerUserId,
      text: e.text,
      attachments: e.attachments,
    };
    await appBroker.publish({ topic: Topics.AIRequest, payload: request });
  });
}
