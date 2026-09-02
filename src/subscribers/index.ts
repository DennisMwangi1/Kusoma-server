import type { Broker } from "../pkg/broker/broker.js";
import { registerAIOrchestrator } from "./ai-orchestrator.js";
import { registerAnalytics } from "./analytics.js";
import { registerAppRealtimeBroadcaster } from "./app-realtime-broadcaster.js";
import { registerAssignmentAdvisor } from "./assignment-advisor.js";
import { registerMessageStore } from "./message-store.js";
import { registerRouter } from "./router.js";
import { registerTelegramSender } from "./telegram-sender.js";

/**
 * Register every subscriber at startup (§6.3).
 *
 * No subscriber imports another — they only share the Broker and the database.
 * Adding one means adding a file and a line here, nothing else.
 */
export async function registerSubscribers(broker: Broker): Promise<void> {
  await registerMessageStore(broker);
  await registerRouter(broker);
  await registerAIOrchestrator(broker);
  await registerAnalytics(broker);
  await registerTelegramSender(broker);
  await registerAppRealtimeBroadcaster(broker);
  await registerAssignmentAdvisor(broker);

  console.log("subscribers: 7 registered");
}
