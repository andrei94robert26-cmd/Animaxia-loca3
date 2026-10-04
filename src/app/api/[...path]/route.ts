import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const DEFAULT_PORT = 4000;

const ALLOWED_PORTS = new Set([
  4000,
  4010,
  4020,
  4040,
  4050,
  4060,
]);

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function selectedPort(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('XTransformPort');
  const port = raw ? Number.parseInt(raw, 10) : DEFAULT_PORT;

  return Number.isInteger(port) && ALLOWED_PORTS.has(port)
    ? port
    : DEFAULT_PORT;
}

async function proxyRequest(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const port = selectedPort(request);

  const target = new URL(
    `/api/${path.map(encodeURIComponent).join('/')}`,
    `http://127.0.0.1:${port}`,
  );

  request.nextUrl.searchParams.forEach((value, key) => {
    if (key !== 'XTransformPort') {
      target.searchParams.append(key, value);
    }
  });

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('connection');
    responseHeaders.delete('keep-alive');
    responseHeaders.set('x-animaxia-proxy-port', String(port));

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Service unavailable',
        port,
        detail: error instanceof Error ? error.message : String(error),
      },
      {
        status: 502,
        headers: {
          'x-animaxia-proxy-port': String(port),
        },
      },
    );
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}
