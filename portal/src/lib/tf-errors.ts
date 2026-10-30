// Turns Terraform failures a user can act on into plain messages. Pure (no I/O) so
// scripts/check-tf-errors.sh can check it on its own.

// What AWS calls "a resource with that name is already there", per service.
const EXISTS = /AlreadyExists|already exists?|ResourceExistsException|ResourceInUseException|BucketAlreadyOwnedByYou|ResourceConflictException/i;

/**
 * Names Terraform could not create because they already exist in the account, from
 * its "Error: creating <Type> (<name>): ..." blocks. Empty when the failure is anything else.
 */
export function existingResources(tfOutput: string): string[] {
  const names: string[] = [];
  for (const block of tfOutput.split(/(?=Error: )/)) {
    const m = block.match(/^Error: creating ([^(]+?) \(([^)]+)\)/);
    if (m && EXISTS.test(block) && !names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

/** A deploy failure as the user should read it; Terraform's own text when there is nothing better to say. */
export function deployErrorMessage(err: { message?: string; stderr?: string }, accountId: string): string {
  const names = existingResources(`${err.stderr ?? ''}\n${err.message ?? ''}`);
  if (!names.length) return err.message ?? String(err);
  return `Already exists in account ${accountId}: ${names.join(', ')}. These are left over from an earlier install, `
    + 'another tool, or the same scenario deployed in another region (IAM names are account-wide). '
    + 'Remove them, or tear down the other deployment, then deploy again.';
}
