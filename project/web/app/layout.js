import Link from 'next/link';
import LayoutCrashTrigger from '../components/LayoutCrashTrigger';
import './globals.css';

export const metadata = { title: 'Web Demo' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <LayoutCrashTrigger />
        <nav>
          <Link href="/">Home</Link>
          <Link href="/products">Products</Link>
          <Link href="/about">About</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
