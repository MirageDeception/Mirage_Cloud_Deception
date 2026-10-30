import { NextResponse } from 'next/server';
import {
  getDetections,
  updateDetectionStatus,
  DETECTION_STATUSES,
  type DetectionStatus,
} from '@/lib/detections';

export const dynamic = 'force-dynamic';

const isValidStatus = (v: unknown): v is DetectionStatus =>
  typeof v === 'string' && (DETECTION_STATUSES as readonly string[]).includes(v);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get('accountId') || undefined;

    const detections = await getDetections(accountId);
    return NextResponse.json({ detections });
  } catch (error) {
    console.error('[MIRAGE] Error reading detections:', error);
    return NextResponse.json({ detections: [] });
  }
}

/** Advance an alert's triage status: active -> in_progress -> resolved (reopen allowed). */
export async function PATCH(req: Request) {
  try {
    const { pk, sk, status } = (await req.json()) ?? {};

    // The IAM grant is already table-scoped, but validate the key shape too so
    // this endpoint can only ever address an alert row.
    if (
      typeof pk !== 'string' || !pk.startsWith('DETECTION#') ||
      typeof sk !== 'string' || !sk.startsWith('ALERT#')
    ) {
      return NextResponse.json({ error: 'Invalid alert key.' }, { status: 400 });
    }
    if (!isValidStatus(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${DETECTION_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }

    await updateDetectionStatus(pk, sk, status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // The condition fails when the PK/SK no longer resolves to a row, which
    // means the alert was expired by TTL or never existed.
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return NextResponse.json({ error: 'Alert no longer exists.' }, { status: 404 });
    }
    console.error('[MIRAGE] Error updating detection status:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update alert status.' },
      { status: 500 },
    );
  }
}
