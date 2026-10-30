import type { Instrumentation } from 'next';

export function register() {}

/**
 * Next.js calls this for every error thrown on the server: API routes, server
 * components, SSR, server actions, middleware.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportServerError } = await import('./lib/serverErrors');
  await reportServerError(error, { request, context });
};
