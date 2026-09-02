import type { Broker, Handler } from "./broker.js";

/**
 * Ported from tabibu-server's pkg/broker/retry.go: retry a failed subscribe()
 * with staggered backoff at startup, so a provider that isn't ready yet
 * doesn't take the whole server down.
 *
 * Pointless against InMemoryBroker (which cannot fail), which is exactly why
 * it belongs here now — the day a real broker lands, startup already tolerates
 * it being slow to accept connections.
 */
export async function subscribeWithRetry(
  broker: Broker,
  topic: string,
  group: string,
  handler: Handler,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 250;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await broker.subscribe(topic, group, handler);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      const delay = baseDelay * 2 ** (attempt - 1);
      console.warn(`broker: subscribe failed (${topic}/${group}), retry ${attempt} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
