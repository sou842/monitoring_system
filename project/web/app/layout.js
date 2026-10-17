import Link from 'next/link';
import ErrorTrackerInit from '../components/ErrorTrackerInit';
import './globals.css';

export const metadata = { title: 'Web Demo' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ErrorTrackerInit />
        <nav>
          <Link href="/">Home</Link>
          <Link href="/products">Products</Link>
          <Link href="/about">About</Link>
          <Link href="/issues">Issues</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
