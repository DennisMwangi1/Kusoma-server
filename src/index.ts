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

/**
 * CORS. The Expo app runs on web (Metro serves it from http://localhost:8081)
 * as well as native, and a browser will not hand a cross-origin response to
 * JS without these headers — so without this middleware `POST /auth/login`
 * succeeds on the server, returns 200, and is still discarded by the browser
 * before the client ever sees the token. curl doesn't enforce CORS, which is
 * why the endpoint tests fine from a terminal and fails in the app.
 *
 * Reflecting the request's own Origin (rather than "*") keeps the door open
 * for cookie/credentialed requests later; "*" is invalid once credentials are
 * involved. This is prototype-appropriate — before anything real ships, pin
 * this to a known origin list.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  // Answer the preflight here — it must not fall through to the routers,
  // which would 404 it (Express's default OPTIONS handler replies 200 with no
  // CORS headers, which the browser reads as "preflight failed").
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

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

  server.listen(env.port, "0.0.0.0", () => {
    console.log(`kusoma-server listening on 0.0.0.0:${env.port}`);
    console.log(`  anthropic: ${env.anthropic.modelId}`);
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
