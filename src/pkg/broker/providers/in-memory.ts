import { EventEmitter } from "node:events";

import type { Broker, Handler, Message } from "../broker.js";

/**
 * The prototype's only provider — a thin wrapper over EventEmitter that
 * satisfies the Broker interface (§6.1).
 *
 * This is the ONLY file in the codebase permitted to import EventEmitter.
 * Subscribers see `Broker` and nothing else, so replacing this with
 * providers/redis-streams.ts changes no subscriber code.
 */
export class InMemoryBroker implements Broker {
  private readonly emitter = new EventEmitter();
  private closed = false;

  constructor() {
    // Fan-out is per-topic; the default limit of 10 is easy to exceed once
    // several subscribers share a topic.
    this.emitter.setMaxListeners(50);
  }

  async publish(msg: Message): Promise<void> {
    if (this.closed) throw new Error("broker: publish after close");
    // Deliver on the next tick so publish() never runs handlers synchronously
    // inside the caller's stack — matches the async semantics of a real broker.
    setImmediate(() => this.emitter.emit(msg.topic, msg));
  }

  async subscribe(topic: string, group: string, ...handlers: Handler[]): Promise<void> {
    for (const handler of handlers) {
      this.emitter.on(topic, (msg: Message) => {
        void handler(msg).catch((err) => {
          // In-memory has no redelivery. A real provider would nack here; we
          // log loudly so a dropped step is visible rather than silent.
          console.error(`broker: handler failed topic=${topic} group=${group}`, err);
        });
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.removeAllListeners();
  }
}
