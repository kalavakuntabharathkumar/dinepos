import type { ReactNode } from 'react';
export const metadata = { title: 'DinePOS', description: 'Restaurant ordering & POS platform' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}