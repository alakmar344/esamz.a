"use client"

import { ClerkProvider } from "@clerk/nextjs"
import ClerkBridge from "./ClerkBridge"

export default function ClerkWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ClerkBridge />
      {children}
    </ClerkProvider>
  )
}
