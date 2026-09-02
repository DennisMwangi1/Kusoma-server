import { createServer } from "node:http";

import express, { type NextFunction, type Request, type Response } from "express";

import { broker } from "./app-broker.js";
import { env } from "./config/env.js";
import { pool } from "./db/client.js";
import { checkReadiness, reportReadiness } from "./db/readiness.js";
import { HttpError } from "./lib/errors.js";
import { attachRealtime } from "./realtime/hub.js";
import { assignmentsRouter } from "./routes/assignments.js";
import { authRouter } from "./routes/auth.js";
import { curriculumRouter } from "./routes/curriculum.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { guardiansRouter } from "./routes/guardians.js";
import { messagesRouter } from "./routes/messages.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { studentsRouter } from "./routes/students.js";
import { telegramWebhookRouter } from "./routes/telegram-webhook.js";
import { registerWebhook } from "./services/telegram.js";
import { registerSubscribers } from "./subscribers/index.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

/**
 * Deeper than /health: actually touches Postgres and reports whether the
 * schema and seed are in place. Use this when the server and the database are
 * on different machines and a request is 500-ing for no obvious reason.
 */
app.get("/health/db", async (_req, res) => {
  const readiness = await checkReadiness();
  res.status(readiness.ok ? 200 : 503).json(readiness);
});

app.use("/auth", authRouter);
app.use("/students", studentsRouter);
// Nested under a student; mergeParams gives these :id from the parent path.
app.use("/students/:id/guardians", guardiansRouter);
app.use("/students/:id/assignments", assignmentsRouter);
app.use("/students/:id/messages", messagesRouter);
app.use("/curriculum", curriculumRouter);
app.use("/dashboard", dashboardRouter);
app.use("/onboarding", onboardingRouter);
app.use("/webhook", telegramWebhookRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error("unhandled error", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = createServer(app);

async function main(): Promise<void> {
  // Report an un-migrated or un-seeded database at boot, naming the fix,
  // rather than letting it surface later as an opaque 500.
  reportReadiness(await checkReadiness().catch((err) => ({
    ok: false,
    problems: [`Readiness check itself failed: ${String(err)}`],
  })));

  await registerSubscribers(broker);
  attachRealtime(server);

  server.listen(env.port, () => {
    console.log(`kusoma-server listening on :${env.port}`);
    console.log(`  bedrock: ${env.bedrock.modelId} @ ${env.bedrock.region}`);
  });

  // Best-effort: never let an unreachable Telegram stop the server booting.
  registerWebhook().catch((err) => console.error("telegram: setWebhook failed", err));
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} — shutting down`);
  server.close();
  await broker.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("fatal: failed to start", err);
  process.exit(1);
});
