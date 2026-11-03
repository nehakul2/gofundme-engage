import './globals.css';
import Header from '@/components/Header';
import Beacon from '@/components/Beacon';

export const metadata = { title: 'Engage' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Manrope:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <Beacon />
        <Header />
        <main>{children}</main>
      </body>
    </html>
  );
}
