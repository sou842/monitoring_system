'use client';

import { useEffect, useState } from 'react';

interface Product {
  id: number;
  name: string;
  price: number;
}

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/demo/products')
      .then((res) => res.json())
      .then((data) => setProducts(data.products))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1>Products</h1>
      {loading && <p>Loading...</p>}
      {products.map((p) => (
        <div className="card" key={p.id}>
          <strong>{p.name}</strong> — ${p.price}
        </div>
      ))}
    </div>
  );
}
