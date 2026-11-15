import { expect, test } from "bun:test";
import { RATE_LIMITS, rateLimited, requestPolicy } from "../src/lib/http/request-policy";
import { signFeedback, verifyFeedback } from "../src/lib/tracing/feedback-token";

test("feedback signatures bind a real trace id, expire and fail closed without the secret", () => {
  const previous = process.env.FEEDBACK_SECRET;
  const traceId = "a".repeat(32);
  const now = 1_800_000_000_000;

  try {
    process.env.FEEDBACK_SECRET = "test-only-secret";
    const token = signFeedback(traceId, now);
    expect(token).not.toBeNull();

    if (!token) throw new Error("No token");
    expect(verifyFeedback(traceId, token, now)).toBe(true);
    expect(verifyFeedback("b".repeat(32), token, now)).toBe(false);
    expect(verifyFeedback(traceId, token, now + 86_400_000)).toBe(false);
    expect(verifyFeedback(traceId, token.slice(0, -1) + "X", now)).toBe(false);
    delete process.env.FEEDBACK_SECRET;
    expect(signFeedback(traceId, now)).toBeNull();
    expect(verifyFeedback(traceId, token, now)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.FEEDBACK_SECRET;
    else process.env.FEEDBACK_SECRET = previous;
  }
});

test("API policy rejects simple cross-site POSTs and limits feedback independently", () => {
  expect(requestPolicy(new Request("https://example.com", { method: "POST" }), "feedback")?.status).toBe(415);
  expect(requestPolicy(new Request("https://example.com", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" } }), "ask")?.status).toBe(403);
  const req = new Request("https://example.com", { headers: { "x-real-ip": "192.0.2.127" } });
  const now = 1_900_000_000_000;

  for (let i = 0; i < 30; i++) expect(rateLimited(req, "feedback", now)).toBe(false);
  expect(rateLimited(req, "feedback", now)).toBe(true);
  expect(rateLimited(req, "ask", now)).toBe(false);
  expect(rateLimited(req, "feedback", now + 600_001)).toBe(false);
});

test("ask allows 30 questions per IP and per 10-minute window", () => {
  const req = new Request("https://example.com", { headers: { "x-real-ip": "192.0.2.128" } });
  const now = 1_900_000_000_000;

  expect(RATE_LIMITS.ask).toBe(30);

  for (let i = 0; i < 30; i++) expect(rateLimited(req, "ask", now)).toBe(false);
  expect(rateLimited(req, "ask", now + 599_999)).toBe(true);
  expect(rateLimited(new Request("https://example.com", { headers: { "x-real-ip": "192.0.2.129" } }), "ask", now)).toBe(false);
  expect(rateLimited(req, "ask", now + 600_000)).toBe(false);
});

test("a full rate-limit table still serves a new address", () => {
  const now = 2_000_000_000_000;
  const visitor = (ip: string) => new Request("https://example.com", { headers: { "x-real-ip": ip } });

  for (let i = 0; i < 10_000; i++) expect(rateLimited(visitor(`198.51.100.${i % 256}:${i}`), "ask", now)).toBe(false);

  const newcomer = visitor("192.0.2.200");

  for (let i = 0; i < 30; i++) expect(rateLimited(newcomer, "ask", now)).toBe(false);
  expect(rateLimited(newcomer, "ask", now)).toBe(true);
});
