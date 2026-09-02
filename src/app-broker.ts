import type { Broker } from "./pkg/broker/broker.js";
import { InMemoryBroker } from "./pkg/broker/providers/in-memory.js";

/**
 * The process-wide broker instance.
 *
 * Lives in its own module so routes and subscribers share one instance without
 * importing each other, and so swapping the provider is a one-line change
 * here rather than a hunt through the codebase (§6.1).
 */
export const broker: Broker = new InMemoryBroker();
