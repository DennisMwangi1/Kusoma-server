/**
 * Phone matching for Telegram contact ↔ Kusoma user.phone.
 *
 * Stored numbers are usually `07XXXXXXXX`. Telegram contacts arrive as
 * `2547XXXXXXXX` or `+254 7XX XXX XXX`. Last-9 comparison covers Kenya
 * mobiles without forcing a single stored format. Student and guardian may
 * share a number; callers decide which user row to match.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = phoneKey(a);
  const kb = phoneKey(b);
  return ka !== null && ka === kb;
}
