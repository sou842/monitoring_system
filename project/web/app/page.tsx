'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * `/`: opens the dashboard. Links from the old single-page dashboard used hash
 * routes (`/#/i/<issue id>`, `/#/p/<project id>?status=all`, `/#/performance?…`);
 * the hash never reaches the server, so it is translated here.
 */
function pathForHash(hash: string): string {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const search = query ? `?${query}` : '';
  if (parts[0] === 'i' && parts[1]) return `/issues/${encodeURIComponent(parts[1])}${search}`;
  if (parts[0] === 'p' && parts[1]) return `/projects/${encodeURIComponent(parts[1])}${search}`;
  if (['dashboard', 'performance', 'projects', 'account', 'admin', 'login', 'signup'].includes(parts[0])) return `/${parts[0]}${search}`;
  return '/dashboard';
}

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(pathForHash(window.location.hash));
  }, [router]);
  return null;
}
