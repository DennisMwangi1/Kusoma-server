import bcrypt from "bcryptjs";

const ROUNDS = 10;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);

/**
 * A user with no password_hash (student, bot) can never authenticate — the
 * check short-circuits rather than comparing against NULL.
 */
export const verifyPassword = (plain: string, hash: string | null): Promise<boolean> =>
  hash ? bcrypt.compare(plain, hash) : Promise.resolve(false);
