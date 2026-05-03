'use client'

import dynamic from 'next/dynamic'

const ClerkWrapper = dynamic(() => import('./ClerkWrapper'), { ssr: false })

export default function DynamicClerkWrapper({ children }: { children: React.ReactNode }) {
  return <ClerkWrapper>{children}</ClerkWrapper>
}
