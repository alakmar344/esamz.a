'use client'

import { useEffect } from 'react'

const APP_VERSION = 'v2.1.3'

export default function PwaInit() {
  useEffect(() => {
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.error('Service worker registration failed:', err))

      // Update all registered service workers to pick up new builds
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => reg.update())
      })
    }

    // Version check: reload once when app version changes (skip on first visit)
    const stored = localStorage.getItem('app_version')
    if (stored !== null && stored !== APP_VERSION) {
      localStorage.setItem('app_version', APP_VERSION)
      window.location.reload()
      return
    }
    localStorage.setItem('app_version', APP_VERSION)

    // Soft fallback: catch chunk-load / addEventListener errors and reload once per session
    const handleError = (e: ErrorEvent) => {
      if (e.message?.includes('addEventListener') || e.message?.includes('Loading chunk')) {
        if (!sessionStorage.getItem('error_reloaded')) {
          sessionStorage.setItem('error_reloaded', '1')
          window.location.reload()
        }
      }
    }
    window.addEventListener('error', handleError)

    // Auto-reload every 60 s when a new deployment is detected via ETag.
    // Pre-populate the cached ETag so the first interval tick can compare correctly.
    fetch(window.location.href, { cache: 'no-store' })
      .then((res) => {
        const etag = res.headers.get('etag')
        if (etag) sessionStorage.setItem('page_etag', etag)
      })
      .catch(() => {/* network offline – skip */})

    const interval = setInterval(() => {
      fetch(window.location.href, { cache: 'no-store' })
        .then((res) => {
          const newEtag = res.headers.get('etag')
          const cachedEtag = sessionStorage.getItem('page_etag')
          if (newEtag) {
            if (cachedEtag && cachedEtag !== newEtag) {
              window.location.reload()
            } else {
              sessionStorage.setItem('page_etag', newEtag)
            }
          }
        })
        .catch(() => {/* network offline – skip */})
    }, 60000)

    return () => {
      window.removeEventListener('error', handleError)
      clearInterval(interval)
    }
  }, [])

  return null
}
