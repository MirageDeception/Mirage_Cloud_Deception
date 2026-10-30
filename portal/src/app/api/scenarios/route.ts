import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { COMING_SOON, listScenarioDirs } from '@/lib/scenarios';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Official scenarios (GitHub-synced, or the bundled scenarios/ before the
    // first sync) then private custom ones -- see lib/scenarios.ts.
    const dirs = await listScenarioDirs();
    if (dirs.length === 0) {
      console.error('No scenarios found in either source');
      return NextResponse.json({ error: 'Failed to read scenarios' }, { status: 500 });
    }

    const scenarios = [];

    for (const { id: folder, dir, source } of dirs) {
      // Only Terraform-backed scenarios are deployable by the portal. A dir with
      // no main.tf is skipped so it never appears as deployable.
      try {
        await fs.access(path.join(dir, 'main.tf'));
      } catch {
        continue;
      }
      // populate-manifest.json presence is the sole "supports Populate" signal
      // -- no details.md parsing needed.
      let populateSupported = false;
      try {
        await fs.access(path.join(dir, 'populate-manifest.json'));
        populateSupported = true;
      } catch {
        populateSupported = false;
      }
      const detailsPath = path.join(dir, 'details.md');
      try {
        const content = await fs.readFile(detailsPath, 'utf-8');
        const lines = content.split('\n');
        
        // Extract Name
        let name = lines[0].replace(/^#\s*/, '').trim();
        name = name.charAt(0).toUpperCase() + name.slice(1);
        
        // Extract Description
        const descLines = [];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim().startsWith('#')) {
            descLines.push(lines[i]);
          }
        }
        let rawDescription = descLines.join('\n').trim();
        rawDescription = rawDescription.replace(/^Description:\s*/i, '');

        let description = rawDescription;
        let resources = "";
        
        const splitIndex = rawDescription.indexOf('**Resources Deployed:**');
        if (splitIndex !== -1) {
          description = rawDescription.substring(0, splitIndex).trim();
          resources = rawDescription.substring(splitIndex + '**Resources Deployed:**'.length).trim();
        }

        // Add to our payload
        scenarios.push({
          id: folder,
          name,
          description,
          resources,
          comingSoon: COMING_SOON.has(folder),
          source,
          populateSupported
        });
      } catch {
        console.error(`Skipping ${folder}, no valid details.md found.`);
      }
    }

    return NextResponse.json(scenarios);
  } catch (error) {
    console.error("Error in /api/scenarios:", error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
