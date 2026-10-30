import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import { prepareUpload, saveUpload, customExists, deleteCustom } from '@/lib/custom-scenarios';
import { assertValidScenarioId } from '@/lib/tf-render';

export const dynamic = 'force-dynamic';

/**
 * Upload a custom scenario (multipart form: name, description, file=<zip>, action, replace).
 *   action=check -> run every check, return the resource list + errors; nothing is saved.
 *   action=save  -> same checks; saved only if they all pass.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a multipart form upload.' }, { status: 400 });
  }
  const name = String(form.get('name') ?? '');
  const description = String(form.get('description') ?? '');
  const file = form.get('file');
  const action = form.get('action') === 'save' ? 'save' : 'check';
  const replace = form.get('replace') === 'true';
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Attach a .zip of the scenario folder.' }, { status: 400 });
  }

  let prepared;
  try {
    prepared = await prepareUpload({ name, description, zip: Buffer.from(await file.arrayBuffer()) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const exists = await customExists(prepared.result.id);

  if (action === 'check') {
    await fs.rm(prepared.work, { recursive: true, force: true });
    return NextResponse.json({ ...prepared.result, exists });
  }
  if (!prepared.result.ok) {
    await fs.rm(prepared.work, { recursive: true, force: true });
    return NextResponse.json({ ...prepared.result, exists, error: 'Scenario failed the checks; nothing was saved.' }, { status: 422 });
  }
  if (exists && !replace) {
    await fs.rm(prepared.work, { recursive: true, force: true });
    return NextResponse.json({ ...prepared.result, exists, error: `${prepared.result.id} already exists.` }, { status: 409 });
  }
  try {
    const warning = await saveUpload(prepared, replace);
    return NextResponse.json({ ...prepared.result, saved: true, warning });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** DELETE ?id=custom-<name> -- refused while the scenario is still deployed anywhere. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  try {
    assertValidScenarioId(id);
    if (!id.startsWith('custom-')) throw new Error('Only custom scenarios can be deleted here.');
    if (!(await customExists(id))) return NextResponse.json({ error: `${id} not found.` }, { status: 404 });
    await deleteCustom(id);
    return NextResponse.json({ deleted: id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
