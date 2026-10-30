export const dynamic = 'force-dynamic';

/** A server component that throws while rendering on the server. */
export default function ServerErrorPage() {
  throw new Error('Server component failed to render');
}
