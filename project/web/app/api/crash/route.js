/** A server-side bug in an API route. */
export function GET() {
  throw new Error('Database connection failed in /api/crash');
}
