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

export const FEEDBACK_SCORE = "response_rating";

const SEND_TIMEOUT_MS = 3000;

type LangfuseConfig = { publicKey: string; secretKey: string; baseUrl: string };

export function langfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim().replace(/\/+$/, "");

  return publicKey && secretKey && baseUrl ? { publicKey, secretKey, baseUrl } : null;
}

export function sampleRate(raw = process.env.LANGFUSE_SAMPLE_RATE): number {
  const rate = Number(raw?.trim() || 1);

  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1;
}

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

const Text = z.union([z.string().transform(maskPersonalData), z.array(z.string().transform(maskPersonalData))]);

const environment = () => process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || process.env.VERCEL_ENV || "development";

let processor: LangfuseSpanProcessor | null = null;
let provider: BasicTracerProvider | null = null;
let telemetryRegistered = false;

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

  provider = new BasicTracerProvider({
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate()) }),
    spanProcessors: [new MaskingSpanProcessor(processor)],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  setLangfuseTracerProvider(provider);

  if (!telemetryRegistered) {
    registerTelemetry(llmTelemetry);
    telemetryRegistered = true;
  }

  return true;
}

export async function shutdownTracing(): Promise<void> {
  const current = provider;

  provider = null;
  processor = null;
  setLangfuseTracerProvider(null);
  context.disable();
  await current?.shutdown();
}

const timeout = () => new Promise<void>((resolve) => setTimeout(resolve, SEND_TIMEOUT_MS).unref());

export async function flushTracing(): Promise<void> {
  if (!processor) return;

  try {
    await Promise.race([processor.forceFlush(), timeout()]);
  } catch (err) {
    console.warn("langfuse flush failed:", err instanceof Error ? err.message : err);
  }
}

export type Feedback = { traceId: string; value: 0 | 1; comment?: string };

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
