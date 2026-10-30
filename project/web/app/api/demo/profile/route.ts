// Returns 200 but with the profile missing: the shape the UI didn't expect.
export function GET() {
  return Response.json({ profile: null });
}
