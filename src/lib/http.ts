import type { Request } from "express";

import { badRequest } from "./errors.js";

/**
 * Express 5 types route params as `string | string[]` (a repeated `?id=` can
 * produce an array). Every downstream consumer — Drizzle's `eq()`, zod, our
 * own uuid checks — wants a plain string, and passing the union straight
 * through makes Drizzle's overload resolution collapse to `never` with a
 * thoroughly unhelpful error. Narrow once, here.
 */
export function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw badRequest(`Missing route parameter: ${name}`);
  return value;
}

/** Same narrowing for query strings, where arrays are genuinely common. */
export function queryParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : undefined;
  return typeof raw === "string" ? raw : undefined;
}
