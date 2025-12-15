// api/index.ts
export const config = { runtime: 'edge' };

export default async function (req: Request): Promise<Response> {
  // ---- FORCE LOG ----
  console.log('🔧 BOOM-trace');          // ← will appear in Vercel logs
  throw new Error('BOOM-trace');        // ← guarantees visible error
}
