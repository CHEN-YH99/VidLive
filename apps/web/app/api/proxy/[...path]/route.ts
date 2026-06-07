import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProxyContext = {
  params: Promise<{
    path?: string[];
  }>;
};

const defaultTargetOrigin = 'http://127.0.0.1:3001';
const hopByHopHeaders = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const responseRewriteHeaders = ['content-encoding', 'content-length', 'transfer-encoding'];

async function proxyRequest(request: Request, context: ProxyContext): Promise<Response> {
  const { path = [] } = await context.params;
  const targetUrl = new URL(createTargetUrl(path, request.url));
  const headers = new Headers(request.headers);

  for (const header of hopByHopHeaders) {
    headers.delete(header);
  }

  try {
    return await pipeNodeRequest(request, targetUrl, headers);
  } catch (error) {
    return Response.json(
      {
        code: 'api-proxy-failed',
        message: error instanceof Error ? error.message : 'VidLive API 代理请求失败。',
        target: targetUrl.toString(),
      },
      { status: 502 },
    );
  }
}

function createTargetUrl(path: string[], requestUrl: string): string {
  const request = new URL(requestUrl);
  const target = new URL(process.env.API_PROXY_TARGET ?? defaultTargetOrigin);
  const prefix = target.pathname.replace(/\/$/, '');
  const suffix = path.map((part) => encodeURIComponent(part)).join('/');

  target.pathname = suffix ? `${prefix}/${suffix}` : prefix || '/';
  target.search = request.search;

  return target.toString();
}

function pipeNodeRequest(request: Request, targetUrl: URL, headers: Headers): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = targetUrl.protocol === 'https:' ? https : http;
    const upstreamRequest = client.request(
      targetUrl,
      {
        headers: toOutgoingHeaders(headers),
        method: request.method,
      },
      (upstreamResponse) => {
        const responseHeaders = new Headers();

        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (!value) {
            continue;
          }

          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(key, item);
            }
          } else {
            responseHeaders.set(key, value);
          }
        }

        for (const header of responseRewriteHeaders) {
          responseHeaders.delete(header);
        }

        resolve(
          new Response(Readable.toWeb(upstreamResponse) as ReadableStream<Uint8Array>, {
            headers: responseHeaders,
            status: upstreamResponse.statusCode ?? 502,
            statusText: upstreamResponse.statusMessage ?? '',
          }),
        );
      },
    );

    upstreamRequest.on('error', reject);

    if (request.method === 'GET' || request.method === 'HEAD' || !request.body) {
      upstreamRequest.end();
      return;
    }

    const requestBody = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);
    requestBody.on('error', reject);
    requestBody.pipe(upstreamRequest);
  });
}

function toOutgoingHeaders(headers: Headers): http.OutgoingHttpHeaders {
  const outgoingHeaders: http.OutgoingHttpHeaders = {};

  headers.forEach((value, key) => {
    outgoingHeaders[key] = value;
  });

  return outgoingHeaders;
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const OPTIONS = proxyRequest;
