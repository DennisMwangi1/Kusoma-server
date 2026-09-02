import type { AssignmentSuggested, MessageInbound, MessageOutbound } from "../events/types.js";
import type { Broker, Message } from "../pkg/broker/broker.js";
import { Topics } from "../pkg/broker/broker.js";
import { subscribeWithRetry } from "../pkg/broker/retry.js";
import { hub } from "../realtime/hub.js";

/**
 * AppRealtimeBroadcaster — pushes messages to connected Expo clients (§6.3).
 *
 * Recipients come from chat_participants (resolved inside the Hub), NOT from a
 * role branch. If a guardian is added to a student later, they start receiving
 * live frames because a row exists — no change here.
 *
 * This and TelegramSender are two independent subscribers to the same event,
 * which is what stops the WS layer and the Telegram relay from drifting apart.
 */
export async function registerAppRealtimeBroadcaster(broker: Broker): Promise<void> {
  await subscribeWithRetry(broker, Topics.MessageInbound, "app-realtime", async (msg: Message) => {
    const e = msg.payload as MessageInbound;
    hub.broadcast(e.chatGroupId, "message", {
      chatGroupId: e.chatGroupId,
      senderUserId: e.senderUserId,
      senderRole: e.senderRole,
      platform: e.platform,
      content: e.text,
      attachments: e.attachments,
      createdAt: e.timestamp,
    });
  });

  await subscribeWithRetry(broker, Topics.MessageOutbound, "app-realtime", async (msg: Message) => {
    const e = msg.payload as MessageOutbound;
    // TelegramSender republishes persisted tutor messages solely to stamp
    // telegramMessageId. The original event already went out over WS.
    if (e.persisted && e.telegramMessageId) return;

    hub.broadcast(e.chatGroupId, "message", {
      chatGroupId: e.chatGroupId,
      senderUserId: e.senderUserId,
      senderRole: e.senderRole,
      platform: "app",
      content: e.text,
      attachments: e.attachments ?? [],
      createdAt: new Date(),
    });
  });

  // Surface AI-suggested assignments to connected tutors in real time (§9.2).
  await subscribeWithRetry(broker, Topics.AssignmentSuggested, "app-realtime", async (msg: Message) => {
    const e = msg.payload as AssignmentSuggested;
    // Broadcast to every room for this student — the tutor will see the
    // assignment_update frame on the Student Detail view.
    hub.broadcastToUser(e.ownerUserId, "assignment_update", {
      assignmentId: e.assignmentId,
      studentUserId: e.studentUserId,
      rationale: e.rationale,
    });
  });
}
