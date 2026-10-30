export function GET() {
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}
