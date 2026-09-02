/**
 * Provider-agnostic pub/sub — §6.1. Mirrors tabibu-server's
 * pkg/broker/broker.go 1:1 on purpose.
 *
 * Subscribers only ever import from this file. Nothing in src/subscribers/
 * may import EventEmitter directly, and no subscriber may import another
 * subscriber. That discipline is what lets the in-memory provider be swapped
 * for Redis Streams / RabbitMQ / pg-boss later by adding one file.
 */

export interface Message {
  topic: string;
  /** For future partitioning/routing (Kafka, RabbitMQ). Unused in-memory. */
  key?: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export type Handler = (msg: Message) => Promise<void>;

export interface Broker {
  publish(msg: Message): Promise<void>;
  /**
   * Non-blocking; starts consumption in the background. A handler that throws
   * signals the message should be retried/nacked, depending on the provider's
   * policy.
   */
  subscribe(topic: string, group: string, ...handlers: Handler[]): Promise<void>;
  close(): Promise<void>;
}

/** Topic names. Keep this list exhaustive — it is the whole event surface. */
export const Topics = {
  MessageInbound: "message.inbound",
  MessageOutbound: "message.outbound",
  AIRequest: "ai.request",
  AIResponse: "ai.response",
  AssignmentSuggested: "assignment.suggested",
} as const;

export type Topic = (typeof Topics)[keyof typeof Topics];
