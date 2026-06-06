'use client'

import { useEffect, useRef } from 'react'
import { useAuth, useClerk } from '@clerk/nextjs'

declare global {
  interface Window {
    __clerk: {
      isSignedIn: boolean
      openSignIn: () => void
      getToken: () => Promise<string | null>
    }
    __syncTierFromServer?: () => void
  }
}

export default function ClerkBridge() {
  const { isSignedIn, getToken } = useAuth()
  const { openSignIn } = useClerk()

  const isSignedInRef = useRef<boolean>(false)
  const getTokenRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null))
  const openSignInRef = useRef<() => void>(() => {})

  useEffect(() => {
    isSignedInRef.current = !!isSignedIn
    // Sync tier from server whenever the user becomes signed in
    if (isSignedIn) {
      window.__syncTierFromServer?.()
    }
    ;(window as any).app?.updatePrivacyAgreementVisibility?.()
  }, [isSignedIn])
  useEffect(() => { openSignInRef.current = () => openSignIn() }, [openSignIn])
  useEffect(() => { getTokenRef.current = getToken }, [getToken])

  useEffect(() => {
    window.__clerk = {
      get isSignedIn() { return isSignedInRef.current },
      openSignIn: () => openSignInRef.current(),
      getToken: () => getTokenRef.current(),
    }
  }, [])

  return null
}
