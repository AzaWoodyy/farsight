const PUBLISHABLE_KEY = /^pk_(?:test|live)_(.+)$/;

export const chatConfigured = (): boolean =>
  Boolean(process.env.CLERK_SECRET_KEY?.trim() && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.THREADS_DATABASE_URL?.trim());

export function clerkHost(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.trim().match(PUBLISHABLE_KEY)?.[1];

  if (!encoded) return null;

  const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");

  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}
