import { clerkMiddleware } from '@clerk/nextjs/server'

if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
  throw new Error('One or more required Clerk environment variables are missing: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY')
}

export default clerkMiddleware()

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
