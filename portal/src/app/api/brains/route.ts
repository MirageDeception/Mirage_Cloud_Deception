import { NextResponse } from 'next/server';
import { getBrains, getActiveBrain } from '@/lib/brains';
import { hubAccountId } from '@/lib/aws-auth';

export async function GET() {
  try {
    const brains = await getBrains();
    const activeBrain = await getActiveBrain();
    // hubAccountId is where a brain actually gets deployed, regardless of any
    // account the form collects. The UI renders it read-only.
    return NextResponse.json({ brains, activeBrain, hubAccountId: hubAccountId() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read brains' },
      { status: 500 },
    );
  }
}
