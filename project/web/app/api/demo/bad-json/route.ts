/** Claims to be JSON but returns HTML, like a proxy error page in production. */
export function GET() {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    headers: { 'Content-Type': 'application/json' },
  });
}
