/**
 * Live smoke suite: Kusoma-server HTTP, CBC API, Anthropic, event pipeline.
 *
 * Demo grades: 7 and 8 mathematics.
 *
 * Usage (from Kusoma-server/):
 *   npm run test:smoke
 */
import "dotenv/config";

import WebSocket from "ws";

import { broker } from "../src/app-broker.js";
import { extractJsonObjectWithKey } from "../src/lib/json.js";
import { Topics } from "../src/pkg/broker/broker.js";
import { AI_SETTINGS, complete, verifyAnthropicAccess } from "../src/services/bedrock.js";
import {
  getCurriculumNode,
  getCurriculumTree,
  searchContent,
  searchCurriculum,
} from "../src/services/cbc-api-client.js";
import { registerSubscribers } from "../src/subscribers/index.js";

const SERVER = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const WS_URL = `ws://127.0.0.1:${process.env.PORT ?? 3000}/ws`;
const CBC_URL = process.env.CBC_API_URL ?? "";
const CBC_KEY = process.env.CBC_API_KEY ?? "";

const DEV = { phone: "0700000000", password: "kusoma-dev" };
const SUBJECT = "mathematics";
const DEMO_GRADES = [7, 8] as const;
const QUERY = "algebra";

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: Result[] = [];

function summarize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value.slice(0, 180);
  if (typeof value !== "object") return String(value);
  const keys = Object.keys(value as object);
  return `{keys:${keys.slice(0, 12).join(",")}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function test(name: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "ok";
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  PASS  ${name}  (${Date.now() - t0}ms)  ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail, ms: Date.now() - t0 });
    console.log(`  FAIL  ${name}  (${Date.now() - t0}ms)  ${detail}`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function json(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

async function cbc(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  assert(CBC_URL && CBC_KEY, "CBC_API_URL / CBC_API_KEY unset");
  return json(`${CBC_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CBC_KEY}`, ...init.headers },
  });
}

type StudentRow = { id: string; grade?: number | null; displayName?: string };

async function main(): Promise<void> {
  let token = "";
  let tutorId = "";
  const students: Record<number, { id: string; chatGroupId: string }> = {};
  const nodeByGrade: Record<number, { id: string; strand: string; subStrand: string; learningOutcome: string }> = {};

  console.log("\n== Kusoma-server HTTP ==\n");

  await test("GET /health", async () => {
    const { status, body } = await json(`${SERVER}/health`);
    assert(status === 200 && (body as { status?: string }).status === "ok", `HTTP ${status} ${summarize(body)}`);
  });

  await test("GET /health/db", async () => {
    const { status, body } = await json(`${SERVER}/health/db`);
    const b = body as { ok?: boolean; problems?: string[] };
    assert(status === 200 && b.ok === true, `HTTP ${status} ${b.problems?.join("; ") ?? ""}`);
  });

  await test("GET /students without token → 401", async () => {
    const { status } = await json(`${SERVER}/students`);
    assert(status === 401, `expected 401 got ${status}`);
  });

  await test("POST /auth/login wrong password → 401", async () => {
    const { status } = await json(`${SERVER}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ phone: DEV.phone, password: "wrong-password" }),
    });
    assert(status === 401, `expected 401 got ${status}`);
  });

  await test("POST /auth/login dev tutor", async () => {
    const { status, body } = await json(`${SERVER}/auth/login`, {
      method: "POST",
      body: JSON.stringify(DEV),
    });
    const b = body as { token?: string; user?: { id: string }; roles?: string[] };
    assert(status === 200 && b.token, `HTTP ${status} ${summarize(body)}`);
    assert(b.roles?.includes("tutor"), `roles=${JSON.stringify(b.roles)}`);
    token = b.token!;
    tutorId = b.user!.id;
    return `user=${tutorId}`;
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  await test("POST /onboarding/complete", async () => {
    const { status, body } = await json(`${SERVER}/onboarding/complete`, {
      method: "POST",
      headers: auth(),
    });
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
  });

  await test("GET /students", async () => {
    const { status, body } = await json(`${SERVER}/students`, { headers: auth() });
    const b = body as { data?: unknown[] };
    assert(status === 200 && Array.isArray(b.data), `HTTP ${status} ${summarize(body)}`);
    return `count=${b.data!.length}`;
  });

  await test("GET /dashboard/summary", async () => {
    const { status, body } = await json(`${SERVER}/dashboard/summary`, { headers: auth() });
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
    const b = body as { activeStudents?: number };
    assert(typeof b.activeStudents === "number", summarize(body));
    return `activeStudents=${b.activeStudents}`;
  });

  for (const grade of DEMO_GRADES) {
    const name = grade === 7 ? "Amina Demo" : "Juma Demo";
    await test(`POST /students Grade ${grade} ${name}`, async () => {
      const phone = `07${grade}${String(Date.now()).slice(-7)}`;
      const { status, body } = await json(`${SERVER}/students`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ firstName: name, grade, phone }),
      });
      const b = body as { student?: StudentRow };
      assert(status === 201 && b.student?.id, `HTTP ${status} ${summarize(body)}`);
      students[grade] = { id: b.student!.id, chatGroupId: "" };
      return `id=${b.student!.id}`;
    });

    await test(`GET /students/:id Grade ${grade}`, async () => {
      const id = students[grade]?.id;
      assert(id, "no student id");
      const { status, body } = await json(`${SERVER}/students/${id}`, { headers: auth() });
      const b = body as { student?: StudentRow; chatGroup?: { id: string } | null };
      assert(status === 200 && b.student?.id === id, `HTTP ${status} ${summarize(body)}`);
      assert(b.student?.grade === grade, `grade=${b.student?.grade}`);
      assert(b.chatGroup?.id, "missing chatGroup");
      students[grade]!.chatGroupId = b.chatGroup!.id;
      return `chatGroup=${b.chatGroup!.id}`;
    });
  }

  await test("PATCH /students/:id Grade 7", async () => {
    const id = students[7]?.id;
    assert(id, "no grade 7 student");
    const { status, body } = await json(`${SERVER}/students/${id}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ firstName: "Amina Demo" }),
    });
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
  });

  await test("GET /students/:id/messages", async () => {
    const id = students[7]?.id;
    const { status, body } = await json(`${SERVER}/students/${id}/messages`, { headers: auth() });
    const b = body as { data?: unknown[] };
    assert(status === 200 && Array.isArray(b.data), `HTTP ${status} ${summarize(body)}`);
    return `count=${b.data!.length}`;
  });

  await test("POST /students/:id/messages (tutor)", async () => {
    const id = students[7]?.id;
    const { status, body } = await json(`${SERVER}/students/${id}/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ text: "Karibu Amina — tufanye algebra pamoja." }),
    });
    const b = body as { message?: { id: string } };
    assert(status === 201 && b.message?.id, `HTTP ${status} ${summarize(body)}`);
    return `id=${b.message!.id}`;
  });

  await test("GET /students/:id/assignments", async () => {
    const id = students[7]?.id;
    const { status, body } = await json(`${SERVER}/students/${id}/assignments`, { headers: auth() });
    const b = body as { data?: unknown[] };
    assert(status === 200 && Array.isArray(b.data), `HTTP ${status} ${summarize(body)}`);
    return `count=${b.data!.length}`;
  });

  for (const grade of DEMO_GRADES) {
    await test(`GET /curriculum/${grade}/mathematics (server proxy)`, async () => {
      const { status, body } = await json(`${SERVER}/curriculum/${grade}/mathematics`, { headers: auth() });
      assert(status === 200, `HTTP ${status} ${summarize(body)}`);
      const data = (body as { data?: unknown }).data;
      assert(Array.isArray(data) && data.length > 0, `expected CurriculumNode[] got ${summarize(body)}`);
      const first = data[0] as {
        id: string;
        strand: string;
        subStrand: string;
        learningOutcome: string;
      };
      assert(first.id && first.strand && first.subStrand && first.learningOutcome, summarize(first));
      nodeByGrade[grade] = first;
      return `n=${data.length} ${first.strand} > ${first.subStrand}`;
    });
  }

  await test("GET /curriculum/node/:id (server proxy, Grade 7 node)", async () => {
    const node = nodeByGrade[7];
    assert(node, "no grade 7 node");
    const { status, body } = await json(`${SERVER}/curriculum/node/${node.id}`, { headers: auth() });
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
    const got = (body as { data?: { id?: string; subStrand?: string; learningOutcome?: string } }).data;
    assert(got?.id === node.id && got.subStrand && got.learningOutcome, summarize(body));
    return `${got.subStrand} > ${got.learningOutcome}`.slice(0, 120);
  });

  await test("POST /students/:id/assignments (Grade 7 active topic)", async () => {
    const id = students[7]?.id;
    const node = nodeByGrade[7];
    assert(id && node, "missing student or node");
    const { status, body } = await json(`${SERVER}/students/${id}/assignments`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        cbcNodeId: node.id,
        strand: node.strand,
        subStrand: node.subStrand,
        learningOutcome: node.learningOutcome,
      }),
    });
    const b = body as { assignment?: { id: string; status: string } };
    assert(status === 201 && b.assignment?.status === "active", `HTTP ${status} ${summarize(body)}`);
    return `id=${b.assignment!.id}`;
  });

  console.log("\n== CBC (Kusoma) API — Grade 7 & 8 mathematics ==\n");

  await test("CBC GET /health", async () => {
    const { status, body } = await json(`${CBC_URL}/health`);
    assert(status === 200 && (body as { status?: string }).status === "ok", `HTTP ${status} ${summarize(body)}`);
  });

  await test("CBC GET /v1/subjects includes mathematics 7/8", async () => {
    const { status, body } = await cbc("/v1/subjects");
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
    const subjects = (body as { subjects?: { id: string; grades_available?: number[] }[] }).subjects;
    const math = subjects?.find((s) => s.id === "mathematics");
    assert(math, "mathematics subject missing");
    const grades = math.grades_available ?? [];
    assert(grades.includes(7) && grades.includes(8), `grades_available=${grades.join(",")}`);
    return `grades=${grades.join(",")}`;
  });

  for (const grade of DEMO_GRADES) {
    await test(`CBC GET /v1/curriculum/mathematics/${grade}`, async () => {
      const { status, body } = await cbc(`/v1/curriculum/mathematics/${grade}`);
      assert(status === 200, `HTTP ${status} ${summarize(body)}`);
      const b = body as { grade?: number; strands?: unknown[] };
      assert(b.grade === grade && Array.isArray(b.strands) && b.strands.length > 0, summarize(body));
      return `strands=${b.strands!.length}`;
    });

    await test(`CBC POST /v1/search Grade ${grade} "${QUERY}"`, async () => {
      const { status, body } = await cbc("/v1/search", {
        method: "POST",
        body: JSON.stringify({ query: QUERY, grade, subject: SUBJECT, limit: 3 }),
      });
      assert(status === 200, `HTTP ${status} ${summarize(body)}`);
      const rows = (body as { results?: unknown[] }).results;
      assert(Array.isArray(rows) && rows.length > 0, `expected hits, got ${summarize(body)}`);
      return `n=${rows.length}`;
    });

    await test(`CBC POST /v1/content/search Grade ${grade} "${QUERY}"`, async () => {
      const { status, body } = await cbc("/v1/content/search", {
        method: "POST",
        body: JSON.stringify({ query: QUERY, grade, subject: SUBJECT, limit: 3 }),
      });
      assert(status === 200, `HTTP ${status} ${summarize(body)}`);
      const rows = (body as { results?: unknown[] }).results;
      assert(Array.isArray(rows) && rows.length > 0, `expected content hits, got n=${Array.isArray(rows) ? rows.length : "n/a"}`);
      const first = rows[0] as { body?: string };
      return `n=${rows.length} q=${String(first.body ?? "").slice(0, 60)}`;
    });
  }

  await test("CBC GET /v1/nodes/:id", async () => {
    const node = nodeByGrade[7];
    assert(node, "no grade 7 node");
    const { status, body } = await cbc(`/v1/nodes/${node.id}`);
    assert(status === 200, `HTTP ${status} ${summarize(body)}`);
    const b = body as { id?: string; learning_outcome?: string };
    assert(b.id === node.id && b.learning_outcome, summarize(body));
  });

  console.log("\n== CBC client adapter ==\n");

  for (const grade of DEMO_GRADES) {
    await test(`searchCurriculum() Grade ${grade}`, async () => {
      const nodes = await searchCurriculum(QUERY, grade, SUBJECT);
      assert(nodes.length > 0, "empty");
      const n = nodes[0]!;
      assert(n.strand && n.subStrand && n.learningOutcome, summarize(n));
      return `${n.strand} > ${n.subStrand} > ${n.learningOutcome}`.slice(0, 160);
    });

    await test(`searchContent() Grade ${grade}`, async () => {
      const rows = await searchContent(QUERY, grade, SUBJECT);
      assert(rows.length > 0 && rows[0]!.question, `empty or unmapped: ${summarize(rows[0])}`);
      return `q=${rows[0]!.question.slice(0, 80)}`;
    });

    await test(`getCurriculumTree() Grade ${grade}`, async () => {
      const nodes = await getCurriculumTree(grade, SUBJECT);
      assert(nodes.length > 0 && nodes[0]!.id && nodes[0]!.subStrand, summarize(nodes[0]));
      return `n=${nodes.length}`;
    });
  }

  await test("getCurriculumNode() Grade 7", async () => {
    const node = await getCurriculumNode(nodeByGrade[7]!.id);
    assert(node.id === nodeByGrade[7]!.id && node.subStrand && node.learningOutcome, summarize(node));
    return `${node.strand} > ${node.subStrand}`;
  });

  console.log("\n== JSON helper ==\n");

  await test("extractJsonObjectWithKey nested braces in strings", async () => {
    const text =
      'Nice work.\n{"performance": {"cbcNodeId": "abc", "isCorrect": false, "errorDetail": "used {x} instead of y"}}';
    const found = extractJsonObjectWithKey(text, "performance");
    assert(found, "no match");
    const parsed = JSON.parse(found.raw) as { performance: { errorDetail: string; isCorrect: boolean } };
    assert(parsed.performance.errorDetail === "used {x} instead of y", found.raw);
    assert(parsed.performance.isCorrect === false, "isCorrect");
  });

  console.log("\n== Anthropic (real tokens) ==\n");

  let anthropicOk = false;
  await test("verifyAnthropicAccess() ping", async () => {
    await verifyAnthropicAccess();
    anthropicOk = true;
    return `model=${process.env.ANTHROPIC_MODEL ?? "default"}`;
  });

  await test("complete() chat — Grade 7 algebra", async () => {
    assert(anthropicOk, "skipped: Anthropic ping failed");
    const grounding = await searchCurriculum(QUERY, 7, SUBJECT);
    const examples = await searchContent(QUERY, 7, SUBJECT);
    const { text, stopReason } = await complete({
      system: [
        "You are a tutor helping a Grade 7 student in Kenya with CBC mathematics.",
        grounding[0]
          ? `Curriculum: ${grounding[0].strand} > ${grounding[0].subStrand} > ${grounding[0].learningOutcome}`
          : "",
        examples[0] ? `Example: ${examples[0].question}` : "",
        "Keep the reply under 80 words. Do not give the answer directly.",
      ].join("\n"),
      userText: "How do I write an algebraic expression for 3 more than x?",
      settings: AI_SETTINGS.chat,
    });
    assert(text.trim().length > 0, `empty text stopReason=${stopReason}`);
    return `stop=${stopReason} chars=${text.length} preview=${text.replace(/\s+/g, " ").slice(0, 100)}`;
  });

  await test("complete() advisor — Grade 8", async () => {
    assert(anthropicOk, "skipped: Anthropic ping failed");
    const { text, stopReason } = await complete({
      system: "You are a CBC curriculum advisor. Respond with ONLY a JSON object.",
      userText:
        'Grade 8 student struggles with algebraic expressions. Suggest one CBC learning outcome as JSON: {"cbcNodeId":"unknown","strand":"...","subStrand":"...","learningOutcome":"...","rationale":"..."}',
      settings: AI_SETTINGS.advisor,
    });
    assert(text.trim().length > 0, `empty text stopReason=${stopReason}`);
    const found = extractJsonObjectWithKey(text, "cbcNodeId") ?? extractJsonObjectWithKey(text, "rationale");
    return `stop=${stopReason} json=${found ? "yes" : "no"} preview=${text.replace(/\s+/g, " ").slice(0, 100)}`;
  });

  console.log("\n== Event pipeline (MessageStore → Router → AIOrchestrator) ==\n");

  await test("register subscribers in this process", async () => {
    await registerSubscribers(broker);
  });

  await test("Grade 7 student inbound → bot reply (Anthropic + CBC)", async () => {
    assert(anthropicOk, "skipped: Anthropic ping failed");
    const s = students[7];
    assert(s?.id && s.chatGroupId && tutorId, "missing grade 7 student context");
    const before = await json(`${SERVER}/students/${s.id}/messages`, { headers: auth() });
    const beforeCount = ((before.body as { data?: unknown[] }).data ?? []).length;

    await broker.publish({
      topic: Topics.MessageInbound,
      payload: {
        chatGroupId: s.chatGroupId,
        studentUserId: s.id,
        ownerUserId: tutorId,
        senderUserId: s.id,
        senderRole: "student",
        platform: "telegram",
        text: "How do I form an algebraic expression for 3 more than x?",
        attachments: [],
        timestamp: new Date(),
      },
    });

    const deadline = Date.now() + 180_000;
    let bot: { senderRole?: string; content?: string } | undefined;
    while (Date.now() < deadline) {
      await sleep(2000);
      const { body } = await json(`${SERVER}/students/${s.id}/messages`, { headers: auth() });
      const rows = (body as { data?: Array<{ senderRole?: string; content?: string }> }).data ?? [];
      bot = [...rows].reverse().find((m) => m.senderRole === "bot");
      if (bot?.content && rows.length > beforeCount) break;
    }
    assert(bot?.content, "no bot reply within 180s — check Anthropic/CBC errors in server/smoke logs");
    return bot.content.replace(/\s+/g, " ").slice(0, 140);
  });

  await test("Grade 8 student inbound → bot reply", async () => {
    assert(anthropicOk, "skipped: Anthropic ping failed");
    const s = students[8];
    assert(s?.id && s.chatGroupId && tutorId, "missing grade 8 student context");
    await broker.publish({
      topic: Topics.MessageInbound,
      payload: {
        chatGroupId: s.chatGroupId,
        studentUserId: s.id,
        ownerUserId: tutorId,
        senderUserId: s.id,
        senderRole: "student",
        platform: "telegram",
        text: "Is 2(x + 3) the same as 2x + 6? I think yes.",
        attachments: [],
        timestamp: new Date(),
      },
    });

    const deadline = Date.now() + 180_000;
    let bot: { content?: string } | undefined;
    while (Date.now() < deadline) {
      await sleep(2000);
      const { body } = await json(`${SERVER}/students/${s.id}/messages`, { headers: auth() });
      const rows = (body as { data?: Array<{ senderRole?: string; content?: string }> }).data ?? [];
      bot = [...rows].reverse().find((m) => m.senderRole === "bot");
      if (bot?.content) break;
    }
    assert(bot?.content, "no bot reply within 180s");
    return bot.content.replace(/\s+/g, " ").slice(0, 140);
  });

  console.log("\n== Realtime WebSocket ==\n");

  await test("WebSocket /ws JWT connect", async () => {
    const frame = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("ws timeout"));
      }, 8000);
      ws.on("message", (raw) => {
        clearTimeout(timer);
        const text = String(raw);
        ws.close();
        resolve(text);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`ws HTTP ${res.statusCode}`));
      });
    });
    const parsed = JSON.parse(frame) as { type?: string; data?: { system?: string } };
    assert(parsed.type === "message" && parsed.data?.system === "connected", frame);
    return frame.slice(0, 160);
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("smoke: fatal", err);
  process.exit(1);
});
