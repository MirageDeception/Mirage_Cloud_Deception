import { NextResponse } from 'next/server';
import { getScenario } from '@/lib/db';
import { appendHistory } from '@/lib/history';
import { assumeChain, roleArns, SdkCredentials, spokeExternalId } from '@/lib/aws-auth';
import { populateScenario } from '@/lib/populate';

/** Pulls the region out of a tfstateKey of the form accounts/<accountId>/<region>/<scenarioId>/terraform.tfstate. */
function regionFromTfstateKey(tfstateKey?: string): string | undefined {
  return tfstateKey?.split('/')[2];
}

export async function POST(req: Request) {
  try {
    const { accountId, scenarioId, region: reqRegion, sessionId } = await req.json();

    if (!accountId || !scenarioId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const scenarioRecord = await getScenario(accountId, scenarioId);
    if (!scenarioRecord) {
      return NextResponse.json({ error: `Scenario ${scenarioId} is not deployed in account ${accountId}` }, { status: 404 });
    }

    const region = (typeof reqRegion === 'string' && /^[a-z]{2}-[a-z]+-\d$/.test(reqRegion))
      ? reqRegion
      : regionFromTfstateKey(scenarioRecord.tfstateKey) || 'us-west-2';

    let credentials: SdkCredentials;
    try {
      credentials = await assumeChain({
        targetRoleArn: roleArns.spokeDeploy(accountId),
        externalId: spokeExternalId(),
        region,
        sessionName: 'MiragePopulateSpoke',
      });
    } catch (stsError) {
      console.error('STS AssumeRole chain failed:', stsError);
      return NextResponse.json({ error: `Failed to assume spoke role: ${(stsError as Error).message}` }, { status: 403 });
    }

    const { manifestFound, results } = await populateScenario({
      scenarioId,
      region,
      decoys: scenarioRecord.decoys,
      credentials,
    });

    if (!manifestFound) {
      return NextResponse.json({ error: `No populate-manifest.json found for ${scenarioId}` }, { status: 400 });
    }

    const anyFailed = results.some(r => r.status === 'failed');
    await appendHistory({
      sessionId: sessionId || Date.now().toString(),
      type: 'scenario_populate',
      scenarioId,
      scenarioName: scenarioId,
      accountId,
      status: anyFailed ? 'failed' : 'success',
      error: anyFailed ? results.filter(r => r.status === 'failed').map(r => `${r.label}: ${r.error}`).join('; ') : undefined,
    });

    return NextResponse.json({
      success: !anyFailed,
      scenarioId,
      accountId,
      results,
      message: `Populated ${results.filter(r => r.status === 'success').length}/${results.filter(r => r.status !== 'skipped').length} seed(s) for ${scenarioId}.`,
    });
  } catch (error) {
    console.error('Error in /api/populate-spoke:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
