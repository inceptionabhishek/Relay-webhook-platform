import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Relay · Webhook delivery',
  description: 'Reliable webhook delivery, with a clear view of every attempt.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
