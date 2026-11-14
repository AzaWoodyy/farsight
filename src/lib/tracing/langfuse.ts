/**
 * Langfuse tracing: one trace per question, exported through OpenTelemetry.
 *
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *                          all three are required; without them nothing is
 *                          registered and every span is a no-op (local runs, eval)
 *   LANGFUSE_SAMPLE_RATE   share of questions traced, 0 to 1 (default 1)
 *
 * The tracer provider is not registered globally: only the agent's spans and
 * the AI SDK's model calls reach Langfuse, never Next.js' own request spans
 * (which carry URLs and headers).
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { type Context, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  ParentBasedSampler,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { z } from "zod";
import { llmTelemetry } from "../agent/trace";
import { maskPersonalData } from "./mask";

/** Name of the thumbs up / down score, after the signal it records. */
export const FEEDBACK_SCORE = "response_rating";

/** Upper bound of a flush or a score request: Langfuse being slow never holds a function open. */
const SEND_TIMEOUT_MS = 3000;

type LangfuseConfig = { publicKey: string; secretKey: string; baseUrl: string };

/** The three variables, or null when one is missing: tracing is then off. */
export function langfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim().replace(/\/+$/, "");

  return publicKey && secretKey && baseUrl ? { publicKey, secretKey, baseUrl } : null;
}

/** LANGFUSE_SAMPLE_RATE as a ratio; anything unreadable traces every question. */
export function sampleRate(raw = process.env.LANGFUSE_SAMPLE_RATE): number {
  const rate = Number(raw?.trim() || 1);

  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1;
}

/**
 * Masks every text attribute of a span before the Langfuse processor sees it.
 * The processor's own `mask` option only covers Langfuse inputs, outputs and
 * metadata: the prompt of an LLM call (`gen_ai.input.messages`) would go out as typed.
 */
class MaskingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parent: Context) {
    this.inner.onStart(span, parent);
  }

  onEnd(span: ReadableSpan) {
    for (const [key, value] of Object.entries(span.attributes)) {
      const text = Text.safeParse(value);

      if (text.success) span.attributes[key] = text.data;
    }

    this.inner.onEnd(span);
  }

  forceFlush() {
    return this.inner.forceFlush();
  }

  shutdown() {
    return this.inner.shutdown();
  }
}

/** A text attribute (or a list of texts) with its personal data masked; other values do not parse. */
const Text = z.union([z.string().transform(maskPersonalData), z.array(z.string().transform(maskPersonalData))]);

/** Langfuse environment of the traces and scores: Vercel's (production, preview) or development. */
const environment = () => process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || process.env.VERCEL_ENV || "development";

let processor: LangfuseSpanProcessor | null = null;

/**
 * Registers the Langfuse exporter and the AI SDK integration, once. Returns
 * false (and registers nothing) without the three variables. `exporter`
 * replaces the network exporter in tests.
 */
export function startTracing(exporter?: SpanExporter): boolean {
  if (processor) return true;
  const config = langfuseConfig();

  if (!config && !exporter) return false;

  processor = new LangfuseSpanProcessor({
    ...config,
    exporter,
    environment: environment(),
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    timeout: SEND_TIMEOUT_MS / 1000,
  });

  const provider = new BasicTracerProvider({
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate()) }),
    spanProcessors: [new MaskingSpanProcessor(processor)],
  });

  // Spans nest through the active context, which needs a context manager.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  setLangfuseTracerProvider(provider);
  registerTelemetry(llmTelemetry);

  return true;
}

const timeout = () => new Promise<void>((resolve) => setTimeout(resolve, SEND_TIMEOUT_MS).unref());

/** Sends the finished spans. Runs after the response; never throws and never waits more than SEND_TIMEOUT_MS. */
export async function flushTracing(): Promise<void> {
  if (!processor) return;

  try {
    await Promise.race([processor.forceFlush(), timeout()]);
  } catch (err) {
    console.warn("langfuse flush failed:", err instanceof Error ? err.message : err);
  }
}

export type Feedback = { traceId: string; value: 0 | 1; comment?: string };

/**
 * Records a thumbs up (1) or down (0) as a boolean score on the trace. The
 * stable id makes a second click replace the first. False when tracing is
 * off or Langfuse did not accept the score.
 */
export async function sendFeedback(feedback: Feedback, send: typeof fetch = fetch): Promise<boolean> {
  const config = langfuseConfig();

  if (!config) return false;

  try {
    const res = await send(`${config.baseUrl}/api/public/scores`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      },
      body: JSON.stringify({
        id: `${FEEDBACK_SCORE}-${feedback.traceId}`,
        traceId: feedback.traceId,
        name: FEEDBACK_SCORE,
        value: feedback.value,
        dataType: "BOOLEAN",
        comment: feedback.comment,
        environment: environment(),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) console.warn(`langfuse score rejected: HTTP ${res.status}`);

    return res.ok;
  } catch (err) {
    console.warn("langfuse score failed:", err instanceof Error ? err.message : err);

    return false;
  }
}
