import ErrorTracker from '@company/error-tracker-js';

/**
 * Sends a server-side error through the SDK running in Node. The automatic
 * browser collectors don't install on the server; only captureError is used.
 */
export async function reportServerError(error, request, context) {
  if (!ErrorTracker.isInitialized()) {
    const host = request.headers?.host || 'localhost:3000';
    ErrorTracker.init({
      apiKey: process.env.NEXT_PUBLIC_ET_API_KEY,
      // The server needs an absolute URL; default to this app's own receiver.
      endpoint: process.env.ET_SERVER_ENDPOINT || `http://${host}/api/events`,
      environment: process.env.NODE_ENV,
      appVersion: '0.1.0',
      captureScreenshots: false,
    });
  }
  ErrorTracker.captureError(error, {
    source: 'server',
    method: request.method,
    path: request.path,
    route: context.routePath,
    route_type: context.routeType,
    digest: error?.digest ?? null,
  });
  await ErrorTracker.flush();
}
