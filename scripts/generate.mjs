// Regenerates the client from the OpenAPI document of the ControlResell public API.
//
//   npm run generate -- [spec]   # a file or a URL; default: https://api.controlresell.com/api/public/openapi.json
//
// Writes src/generated and .spec-sha256. The document itself is not committed.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@hey-api/openapi-ts';

const spec = process.argv[2] ?? 'https://api.controlresell.com/api/public/openapi.json';
const work = await mkdtemp(join(tmpdir(), 'controlresell-spec-'));
try {
  const text = /^https?:\/\//.test(spec) ? await (await fetch(spec)).text() : await readFile(spec, 'utf8');
  const file = join(work, 'openapi.json');
  await writeFile(file, text);
  await createClient({
    input: file,
    output: { path: 'src/generated', importFileExtension: '.js' },
    plugins: ['@hey-api/client-fetch', '@hey-api/typescript', { name: '@hey-api/sdk', asClass: true }],
  });
  const sha = createHash('sha256').update(text).digest('hex');
  await writeFile('.spec-sha256', `${sha}\n`);
  console.log(`Generated from ${spec} (sha256 ${sha})`);
} finally {
  await rm(work, { recursive: true, force: true });
}
