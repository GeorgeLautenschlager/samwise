import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const root = process.cwd();
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'samwise-package-smoke-'));
try {
  const cwd = path.join(isolated, 'project');
  const agentDir = path.join(isolated, 'agent');
  const memoryDir = path.join(isolated, 'memory');
  fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  for (const directory of ['commitments', 'digests', 'episodes']) fs.mkdirSync(path.join(memoryDir, directory), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: [{ source: root }] }));
  fs.writeFileSync(path.join(memoryDir, 'digests', 'fixture.md'), `---\ntype: digest\ndate: 2025-01-01\nprojects: [Samwise]\ntags: []\nderived: true\nsources:\n  - sessionId: fixture\n    entryIds: [entry]\n---\nShip fixture package.\n`);
  process.env.SAMWISE_MEMORY_DIR = memoryDir;

  const loader = new DefaultResourceLoader({ cwd, agentDir });
  let trustRequested = false;
  await loader.reload({ resolveProjectTrust: async () => { trustRequested = true; return true; } });
  const loaded = loader.getExtensions();
  assert.equal(trustRequested, true, 'project package trust was resolved');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, `one package extension discovered: ${JSON.stringify(loaded.errors)}`);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools instanceof Map);
  assert.ok(extension.commands instanceof Map);
  for (const name of ['recall', 'memory_status', 'memory_consolidate']) assert.ok(extension.tools.has(name), `${name} registered by package loader`);
  assert.ok(extension.commands.has('memory'));
  const recall = extension.tools.get('recall')!;
  const result = await recall.definition.execute('smoke', { query: 'fixture' } as never, undefined, undefined, {} as never);
  assert.match(JSON.stringify(result), /Ship fixture package/);
  const status = await extension.tools.get('memory_status')!.definition.execute('smoke', {} as never, undefined, undefined, {} as never);
  assert.match(JSON.stringify(status), /localDateTime/);
  const prompts = loader.getPrompts().prompts;
  assert.equal(prompts.length, 3, `all three prompts discovered: ${JSON.stringify(loader.getPrompts().diagnostics)}`);

  const evidence = {
    packageRoot: root,
    isolatedProject: cwd,
    discoveredExtension: extension.resolvedPath,
    tools: [...extension.tools.keys()],
    commands: [...extension.commands.keys()],
    prompts: prompts.map((prompt) => prompt.name),
    exercised: ['recall', 'memory_status'],
    projectTrust: 'approved through reload callback',
  };
  fs.writeFileSync('/tmp/samwise-package-smoke.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
