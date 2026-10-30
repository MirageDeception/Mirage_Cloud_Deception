import { NextResponse } from 'next/server';
import { after } from 'next/server';
import {
  listJobs,
  createJob,
  runJob,
  findActiveConflict,
  JOB_STATUSES,
  JOB_TYPES,
  type JobStatus,
  type JobType,
} from '@/lib/jobs';

export const dynamic = 'force-dynamic';

const isStatus = (v: unknown): v is JobStatus =>
  typeof v === 'string' && (JOB_STATUSES as readonly string[]).includes(v);
const isType = (v: unknown): v is JobType =>
  typeof v === 'string' && (JOB_TYPES as readonly string[]).includes(v);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const type = searchParams.get('type');

    const jobs = await listJobs({
      status: isStatus(status) ? status : undefined,
      type: isType(type) ? type : undefined,
    });
    return NextResponse.json({ jobs });
  } catch (error) {
    console.error('[MIRAGE] Error listing jobs:', error);
    return NextResponse.json({ jobs: [] });
  }
}

/**
 * Creates a job. Only 'noop' is accepted here -- it exists to exercise the whole
 * pipeline (store, polling, progress bar, bell) without touching AWS. Real work is
 * started by its own route (deploy-brain etc.), which creates its own job.
 */
export async function POST(req: Request) {
  try {
    const { type = 'noop' } = (await req.json().catch(() => ({}))) ?? {};

    if (type !== 'noop') {
      return NextResponse.json(
        { error: `Only 'noop' can be started here. Use the operation's own route for ${type}.` },
        { status: 400 },
      );
    }

    const conflict = await findActiveConflict('noop');
    if (conflict) {
      return NextResponse.json(
        { error: 'A noop job is already running.', jobId: conflict.id },
        { status: 409 },
      );
    }

    const job = await createJob({ type: 'noop', label: 'Self-test job', total: 4 });

    // after() runs post-response work on a supported hook rather than a dangling
    // promise, which is not guaranteed to complete once the response is sent.
    after(async () => {
      await runJob(job.id, async report => {
        const phases = ['checking store', 'writing progress', 'halfway', 'finishing'];
        for (let i = 0; i < phases.length; i++) {
          await new Promise(r => setTimeout(r, 2000));
          await report(phases[i], { phase: phases[i], current: i + 1, total: phases.length });
        }
      });
    });

    return NextResponse.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    console.error('[MIRAGE] Error creating job:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create job.' },
      { status: 500 },
    );
  }
}
