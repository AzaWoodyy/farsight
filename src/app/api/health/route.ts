import { connection } from "next/server";
import { openDb } from "@/lib/db";
import { type DatabaseHealth, databaseHealth } from "@/lib/db/health";

// Read once per instance: the database is read-only, so the answer cannot change.
let health: DatabaseHealth | null = null;

/**
 * Public, read-only: which database this deployment serves. The Deploy workflow
 * compares it with the code's schema version and the release's game count.
 */
export async function GET() {
  // node:sqlite is synchronous: without this, the answer would be computed at build time.
  await connection();

  try {
    health ??= databaseHealth(openDb());

    return Response.json(health, { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } });
  } catch (err) {
    console.error(err instanceof Error ? err.name : "HealthError");

    return Response.json({ error: "database unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
