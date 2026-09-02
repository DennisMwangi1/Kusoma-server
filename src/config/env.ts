import "dotenv/config";

/**
 * Environment contract — §13 of the migration spec.
 *
 * Only DATABASE_URL and JWT_SECRET are hard requirements at boot. Everything
 * else degrades: the CBC client stubs itself out (§10), Telegram skips
 * setWebhook, and Bedrock fails at call time rather than at startup. That is
 * deliberate — a scaffold has to boot on a laptop with half the integrations
 * unconfigured (§16).
 */

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),

  backendUrl: process.env.BACKEND_URL ?? "",

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
  },

  cbc: {
    url: process.env.CBC_API_URL ?? "",
    apiKey: process.env.CBC_API_KEY ?? "",
  },

  // AWS Bedrock (§9.0). Credentials themselves are read by the SDK from the
  // standard AWS chain — we never touch AWS_ACCESS_KEY_ID here.
  bedrock: {
    region: process.env.AWS_REGION ?? "us-east-1",
    modelId: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-5",
  },
} as const;

export const isTelegramConfigured = () => Boolean(env.telegram.botToken);
export const isCbcConfigured = () => Boolean(env.cbc.url && env.cbc.apiKey);
