import { createHmac, timingSafeEqual } from "node:crypto";

const TRACE_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^(\d{13})\.([0-9a-f]{64})$/;
const LIFETIME_MS = 24 * 60 * 60 * 1_000;

export function signFeedback(traceId: string, now = Date.now()): string | null {
  const secret = process.env.FEEDBACK_SECRET;

  if (!secret || !TRACE_ID.test(traceId)) return null;
  const expires = now + LIFETIME_MS;
  const signature = createHmac("sha256", secret).update(`${traceId}.${expires}`).digest("hex");

  return `${expires}.${signature}`;
}

export function verifyFeedback(traceId: string, token: string, now = Date.now()): boolean {
  const secret = process.env.FEEDBACK_SECRET;
  const match = TOKEN.exec(token);

  if (!secret || !TRACE_ID.test(traceId) || !match) return false;
  const expires = Number(match[1]);

  if (expires <= now || expires > now + LIFETIME_MS) return false;
  const expected = createHmac("sha256", secret).update(`${traceId}.${expires}`).digest();

  return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
}
