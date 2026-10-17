export async function GET() {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return Response.json({ ok: true, delayed_ms: 2500 });
}
