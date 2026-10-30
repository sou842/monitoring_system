export function GET() {
  return Response.json({ error: 'Session expired' }, { status: 401 });
}
