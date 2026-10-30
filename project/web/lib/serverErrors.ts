import ErrorTracker from '@sourav732/error-tracker-js';

/** What Next.js passes to `onRequestError` about the request and route. */
export interface RequestErrorInfo {
  request: { path: string; method: string };
  context: { routePath: string; routeType: string };
}

/** The ingestion URL for server-side reports, which must be absolute (the browser one may be relative). */
function serverEndpoint(): string | undefined {
  const configured = process.env.ET_SERVER_ENDPOINT || process.env.NEXT_PUBLIC_ET_ENDPOINT;
  if (configured && /^https?:\/\//.test(configured)) return configured;
  // This app is the backend too: on Vercel, report to this deployment itself.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/v1/events`;
  return `http://localhost:${process.env.PORT || 3000}/api/v1/events`;
}

/**
 * Sends a server-side error through the SDK running in Node. The automatic
 * browser collectors don't install on the server; only captureError is used.
 */
export async function reportServerError(error: unknown, { request, context }: RequestErrorInfo): Promise<void> {
  const endpoint = serverEndpoint();
  if (!ErrorTracker.isInitialized() && process.env.NEXT_PUBLIC_ET_API_KEY && endpoint) {
    ErrorTracker.init({
      apiKey: process.env.NEXT_PUBLIC_ET_API_KEY,
      endpoint,
      environment: process.env.NODE_ENV,
      appVersion: '0.1.0',
    });
  }
  const err = error instanceof Error ? error : new Error(String(error));
  ErrorTracker.captureError(err, {
    source: 'server',
    method: request.method,
    path: request.path,
    route: context.routePath,
    route_type: context.routeType,
    digest: (err as Error & { digest?: string }).digest ?? null,
  });
  await ErrorTracker.flush();
}
