import { NextResponse } from 'next/server';
import { getJob, reconcileOrphans } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }
    // Reconcile here too: a page polling one job directly must still learn that
    // the service restarted and abandoned it.
    const [reconciled] = await reconcileOrphans([job]);
    return NextResponse.json({ job: reconciled ?? job });
  } catch (error) {
    console.error('[MIRAGE] Error reading job:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read job.' },
      { status: 500 },
    );
  }
}
