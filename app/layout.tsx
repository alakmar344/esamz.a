import type { Metadata } from 'next'
import Script from 'next/script'
import PwaInit from './components/PwaInit'
import DynamicClerkWrapper from './components/DynamicClerkWrapper'
import './globals.css'

export const metadata: Metadata = {
  title: 'eSAMz AI — Strategic Artificial Mind',
  description: 'Deep reasoning with emotional clarity — for complex problems that demand more than a quick answer.',
  manifest: '/site.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'eSAMz AI',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon.ico',
  },
}

const clerkPubKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <meta name="theme-color" content="#ffffff" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" /> 
        <meta name="breachme-verify" content="breachme-verify=470293f7483ae0b2f999b84c29c1942a" />
      </head>
      
        
         <body>
  {clerkPubKey ? (
    <DynamicClerkWrapper>
      {children}
    </DynamicClerkWrapper>
  ) : (
    children
  )}

  

        {/* Third-party scripts */}
        <Script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-java.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js" strategy="afterInteractive" />

        {/* Google Analytics (consent-gated per Privacy Policy §4) */}
        <Script id="ga-consent-default" strategy="beforeInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('consent', 'default', {
            'analytics_storage': 'denied',
            'ad_storage': 'denied',
            'wait_for_update': 500
          });
          if (localStorage.getItem('esamz_cookie_consent') === 'accepted') {
            gtag('consent', 'update', { 'analytics_storage': 'granted' });
            var s = document.createElement('script');
            s.async = true;
            s.src = 'https://www.googletagmanager.com/gtag/js?id=G-WRJ3NWVP5B';
            document.head.appendChild(s);
          }
        `}</Script>
        <Script id="ga-config" strategy="afterInteractive">{`
          if (localStorage.getItem('esamz_cookie_consent') === 'accepted') {
            gtag('config', 'G-WRJ3NWVP5B');
          }
        `}</Script>

        {/* PWA service worker registration */}
        <PwaInit />
      </body>
    </html>
  )
}
