import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import type { Report } from './job-runner';

/**
 * Count resources declared in a CloudFormation template.
 *
 * Every resource block has exactly one `Type: AWS::...` (or `Custom::...`) line,
 * which is a more reliable count than parsing YAML with intrinsic tags (!Ref,
 * !GetAtt, !If) that a plain YAML loader rejects.
 */
export function countTemplateResources(template: string): number {
  return (template.match(/^\s+Type:\s*(?:AWS|Custom|AWSQS)::/gm) || []).length;
}

/** Current resource count of a deployed stack. Used as the total for a removal. */
export async function countStackResources(
  cfn: CloudFormationClient,
  stackName: string,
): Promise<number> {
  try {
    const res = await cfn.send(new ListStackResourcesCommand({ StackName: stackName }));
    return (res.StackResourceSummaries || []).length;
  } catch {
    return 0;
  }
}

/**
 * Poll stack events and report how many resources have reached a terminal
 * *_COMPLETE state, giving a real percentage rather than an animation.
 *
 * `since` matters: DescribeStackEvents returns history from previous operations
 * too, so an UPDATE would otherwise instantly count every resource created by the
 * original CREATE and jump straight to 100%. Only events at or after the start of
 * this operation are counted.
 *
 * Returns a stop function. Never throws: a throttle, or a stack that has already
 * been deleted, must not fail the operation it is only observing.
 */
export function startStackProgress(opts: {
  cfn: CloudFormationClient;
  stackName: string;
  total: number;
  /** Added to the reported `current`, so a multi-stack job accumulates one bar. */
  offset?: number;
  /** Grand total across all stacks in this job. */
  grandTotal?: number;
  since: Date;
  phase: string;
  report: Report;
  intervalMs?: number;
}): () => void {
  const {
    cfn, stackName, total, offset = 0, grandTotal, since, phase, report,
    intervalMs = 5000,
  } = opts;

  let stopped = false;
  const seen = new Set<string>();

  (async () => {
    while (!stopped) {
      await new Promise(r => setTimeout(r, intervalMs));
      if (stopped) return;

      try {
        const res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
        for (const e of res.StackEvents || []) {
          if (!e.Timestamp || e.Timestamp < since) continue;
          if (e.ResourceType === 'AWS::CloudFormation::Stack') continue;
          if (!e.LogicalResourceId) continue;
          if (/_COMPLETE$/.test(e.ResourceStatus || '')) seen.add(e.LogicalResourceId);
        }
        const current = Math.min(seen.size, total);
        await report(`${phase}: ${current}/${total} resources`, {
          phase,
          current: offset + current,
          total: grandTotal ?? total,
        });
      } catch {
        // Stack may not exist yet (create) or may already be gone (delete), and
        // throttling is expected. Observation must never break the operation.
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
