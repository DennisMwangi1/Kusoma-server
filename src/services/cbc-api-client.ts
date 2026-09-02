import { env, isCbcConfigured } from "../config/env.js";

/**
 * CBC Curriculum API client — §10. A thin fetch wrapper, nothing more.
 *
 * Failure policy differs per call on purpose:
 *  - getCurriculumTree throws (the Expo app shows an error state)
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

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.cbc.url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": env.cbc.apiKey, ...init.headers },
    });
    if (!res.ok) throw new Error(`CBC API ${res.status} for ${path}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCurriculumTree(grade: number, subject: string): Promise<CurriculumNode[]> {
  if (!isCbcConfigured()) {
    throw new Error("CBC API is not configured (CBC_API_URL / CBC_API_KEY)");
  }
  return request<CurriculumNode[]>(`/v1/curriculum/${subject}/${grade}`, { method: "GET" }, 5000);
}

export async function getCurriculumNode(id: string): Promise<CurriculumNode> {
  if (!isCbcConfigured()) {
    throw new Error("CBC API is not configured (CBC_API_URL / CBC_API_KEY)");
  }
  return request<CurriculumNode>(`/v1/curriculum/node/${id}`, { method: "GET" }, 5000);
}

export async function searchCurriculum(
  query: string,
  grade: number,
  subject: string,
): Promise<CurriculumNode[]> {
  if (!isCbcConfigured()) return [];
  try {
    return await request<CurriculumNode[]>(
      "/v1/search",
      { method: "POST", body: JSON.stringify({ query, grade, subject, limit: 3 }) },
      4000,
    );
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
    return await request<ContentResult[]>(
      "/v1/content/search",
      { method: "POST", body: JSON.stringify({ query, grade, subject, limit: 3 }) },
      4000,
    );
  } catch {
    return [];
  }
}
