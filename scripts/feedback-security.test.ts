import { expect, test } from "bun:test";
import { rateLimited, requestPolicy } from "../src/lib/http/request-policy";
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
