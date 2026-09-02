/**
 * One JSON shape per WS frame, both directions — §6.4.
 * Mirrors tabibu-server's pkg/notify/realtime/envelope.go.
 */
export type EnvelopeType = "message" | "typing" | "assignment_update";

export interface Envelope<T = unknown> {
  type: EnvelopeType;
  data: T;
}

export const envelope = <T>(type: EnvelopeType, data: T): string =>
  JSON.stringify({ type, data } satisfies Envelope<T>);
