import { NextResponse } from 'next/server';

/**
 * GET /api/edge-status — live probe of the cloud origin that the FAZA 8 edge
 * layer (animaxia-edge/, Cloudflare Workers) fronts. The edge gateway's
 * CLOUD_ORIGIN points at this monolith; its /api/health answer (including the
 * Neon database state) is the chain the edge workers accelerate and protect.
 */

const CLOUD_ORIGIN = process.env.CLOUD_ORIGIN || 'http://127.0.0.1:4000';

export async function GET() {
  const started = Date.now();
  try {
    const res = await fetch(`${CLOUD_ORIGIN}/api/health`, {
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    const health = (await res.json().catch(() => null)) as
      | { status?: string; service?: string; uptimeSec?: number; db?: { driver?: string; connected?: boolean; totalItems?: number } }
      | null;
    return NextResponse.json({
      ok: res.ok && health?.status === 'ok',
      upstream: {
        status: res.status,
        healthy: health?.status === 'ok',
        service: health?.service ?? null,
        uptimeSec: health?.uptimeSec ?? null,
        db: health?.db ?? null,
      },
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      upstream: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'cloud origin unreachable',
      checkedAt: new Date().toISOString(),
    });
  }
}
