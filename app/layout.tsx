import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'eSAMz AI — Strategic Artificial Mind',
  description: 'Deep reasoning with emotional clarity — for complex problems that demand more than a quick answer.',
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon.ico',
  },
  manifest: '/site.webmanifest',
}

const clerkPubKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
let ClerkProvider: any, SignInButton: any, SignUpButton: any, Show: any, UserButton: any
if (clerkPubKey) {
  const clerk = require('@clerk/nextjs')
  ClerkProvider = clerk.ClerkProvider
  SignInButton = clerk.SignInButton
  SignUpButton = clerk.SignUpButton
  Show = clerk.Show
  UserButton = clerk.UserButton
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" /> 
        <meta name="breachme-verify" content="breachme-verify=470293f7483ae0b2f999b84c29c1942a" />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-WRJ3NWVP5B"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-WRJ3NWVP5B');
</script>
      </head>
      <body>
        {clerkPubKey ? (
          <ClerkProvider>
            <header style={{ display: 'none' }}>
              <Show when="signed-out">
                <SignInButton />
                <SignUpButton />
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </header>
            {children}
          </ClerkProvider>
        ) : (
          children
        )}

        {/* Third-party scripts */}
        <Script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js" strategy="beforeInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js" strategy="beforeInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-java.min.js" strategy="afterInteractive" />
        <Script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js" strategy="afterInteractive" />

        {/* Google Analytics */}
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-WRJ3NWVP5B" strategy="afterInteractive" />
        <Script id="ga-init" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-WRJ3NWVP5B');
        `}</Script>
      </body>
    </html>
  )
}
