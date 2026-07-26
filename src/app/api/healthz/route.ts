import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { env, isProduction } from "@/lib/env";

/**
 * GET /api/healthz
 *
 * Liveness + readiness probe. Reports:
 *   - DB: a `SELECT 1` round-trip on the Drizzle pool.
 *
 * Returns JSON:
 *   - 200 { status: "ok",       checks: { ... } }
 *   - 503 { status: "degraded", checks: { ... } }
 */

interface Check {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface HealthBody {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  checkedAt: string;
  env: "development" | "test" | "production";
  checks: {
    db: Check;
  };
}

const start = process.hrtime.bigint();

const measure = async (
  fn: () => Promise<void>,
  component: string,
): Promise<Check> => {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    if (isProduction) {
      console.error(`[healthz] ${component} check failed:`, err);
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: `${component}_unavailable`,
      };
    }
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : "unknown",
    };
  }
};

export async function GET(): Promise<Response> {
  const dbCheck = await measure(async () => {
    await db.execute(sql`select 1`);
  }, "db");

  const allOk = dbCheck.ok;

  const body: HealthBody = {
    status: allOk ? "ok" : "degraded",
    uptimeSeconds: Number(
      (process.hrtime.bigint() - start) / 1_000_000_000n,
    ),
    checkedAt: new Date().toISOString(),
    env: env.NODE_ENV,
    checks: {
      db: dbCheck,
    },
  };

  return NextResponse.json(body, {
    status: allOk ? 200 : 503,
    headers: { "Cache-Control": "no-store, must-revalidate" },
  });
}
