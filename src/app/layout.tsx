import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Zeroday',
  description: 'Find market exploits early',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{
          __html: `(function(){try{var t=localStorage.getItem('zd-theme')||'dark';document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
        }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
