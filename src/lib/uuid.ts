/** Normalize a Telegram start payload or pasted id into a dashed UUID. */
export function parseStudentUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Telegram startgroup payloads reject some punctuation — send the UUID without hyphens. */
export function telegramStartPayload(studentUserId: string): string {
  return studentUserId.replace(/-/g, "");
}
