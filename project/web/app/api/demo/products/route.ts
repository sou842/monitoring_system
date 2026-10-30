const PRODUCTS = [
  { id: 1, name: 'Keyboard', price: 49 },
  { id: 2, name: 'Mouse', price: 19 },
  { id: 3, name: 'Monitor', price: 199 },
];

export function GET() {
  return Response.json({ products: PRODUCTS });
}
