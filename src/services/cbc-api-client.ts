import { env, isCbcConfigured } from "../config/env.js";

/**
 * CBC Curriculum API client — §10, adapted to the live Kusoma CBC API.
 *
 * Spec draft used `x-api-key` and flat camelCase arrays. The deployed API
 * authenticates with `Authorization: Bearer`, wraps lists in `{ results }`,
 * and uses snake_case plus a nested strand tree. This module is the adapter.
 *
 * Failure policy differs per call on purpose:
 *  - getCurriculumTree / getCurriculumNode throw (the Expo app shows an error)
 *  - the two search calls return [] (the AI proceeds without grounding)
 *
 * When CBC_API_URL/KEY are unset, these stub out behind an env check so the
 * rest of the system degrades exactly as specced rather than crashing. We do
 * NOT invent fake curriculum data as a fallback.
 */

export interface CurriculumNode {
  id: string;
  strand: string;
  subStrand: string;
  learningOutcome: string;
  teachingApproach?: string;
  suggestedActivities?: string[];
  children?: CurriculumNode[];
}

export interface ContentResult {
  question: string;
  answer?: string;
  solution?: string;
  source?: string;
}

type Json = Record<string, unknown>;

async function request(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.cbc.url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${env.cbc.apiKey}`,
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`CBC API ${res.status} for ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function unwrapList(body: unknown): Json[] {
  if (Array.isArray(body)) return body.filter((row): row is Json => !!row && typeof row === "object");
  const results = asRecord(body).results;
  if (Array.isArray(results)) return results.filter((row): row is Json => !!row && typeof row === "object");
  return [];
}

function mapNode(raw: Json, fallback: { strand?: string; subStrand?: string } = {}): CurriculumNode {
  return {
    id: String(raw.id ?? ""),
    strand: String(raw.strand ?? fallback.strand ?? ""),
    subStrand: String(raw.sub_strand ?? raw.subStrand ?? fallback.subStrand ?? ""),
    learningOutcome: String(raw.learning_outcome ?? raw.learningOutcome ?? raw.outcome ?? ""),
    teachingApproach: typeof raw.description === "string" ? raw.description : undefined,
  };
}

/** CBC returns `{ subject, grade, strands: [{ name, sub_strands: [{ name, learning_outcomes }] }] }`. */
function flattenTree(body: unknown): CurriculumNode[] {
  if (Array.isArray(body)) return body.map((row) => mapNode(asRecord(row)));

  const out: CurriculumNode[] = [];
  const strands = asRecord(body).strands;
  if (!Array.isArray(strands)) return out;

  for (const strand of strands) {
    const s = asRecord(strand);
    const strandName = String(s.name ?? s.strand ?? "");
    const subs = s.sub_strands ?? s.subStrands;
    if (!Array.isArray(subs)) continue;

    for (const sub of subs) {
      const ss = asRecord(sub);
      const subName = String(ss.name ?? ss.sub_strand ?? ss.subStrand ?? "");
      const outcomes = ss.learning_outcomes ?? ss.learningOutcomes;
      if (!Array.isArray(outcomes)) continue;

      for (const outcome of outcomes) {
        out.push(mapNode(asRecord(outcome), { strand: strandName, subStrand: subName }));
      }
    }
  }
  return out;
}

function mapContent(raw: Json): ContentResult {
  const steps = raw.steps;
  const solution = Array.isArray(steps)
    ? steps
        .map((step) => {
          const s = asRecord(step);
          return String(s.explanation ?? s.action ?? "").trim();
        })
        .filter(Boolean)
        .join("; ")
    : undefined;

  const answer = raw.answer ?? raw.ai_generated_answer;
  return {
    question: String(raw.body ?? raw.title ?? raw.question ?? ""),
    answer: typeof answer === "string" && answer.length > 0 ? answer : undefined,
    solution: solution || undefined,
    source: typeof raw.content_type === "string" ? raw.content_type : undefined,
  };
}

export async function getCurriculumTree(grade: number, subject: string): Promise<CurriculumNode[]> {
  if (!isCbcConfigured()) {
    throw new Error("CBC API is not configured (CBC_API_URL / CBC_API_KEY)");
  }
  return flattenTree(await request(`/v1/curriculum/${subject}/${grade}`, { method: "GET" }, 5000));
}

export async function getCurriculumNode(id: string): Promise<CurriculumNode> {
  if (!isCbcConfigured()) {
    throw new Error("CBC API is not configured (CBC_API_URL / CBC_API_KEY)");
  }
  return mapNode(asRecord(await request(`/v1/nodes/${id}`, { method: "GET" }, 5000)));
}

export async function searchCurriculum(
  query: string,
  grade: number,
  subject: string,
): Promise<CurriculumNode[]> {
  if (!isCbcConfigured()) return [];
  try {
    const body = await request(
      "/v1/search",
      { method: "POST", body: JSON.stringify({ query, grade, subject, limit: 3 }) },
      4000,
    );
    return unwrapList(body).map((row) => mapNode(row));
  } catch {
    return [];
  }
}

export async function searchContent(
  query: string,
  grade: number,
  subject: string,
): Promise<ContentResult[]> {
  if (!isCbcConfigured()) return [];
  try {
    const body = await request(
      "/v1/content/search",
      { method: "POST", body: JSON.stringify({ query, grade, subject, limit: 3 }) },
      4000,
    );
    return unwrapList(body).map(mapContent);
  } catch {
    return [];
  }
}
