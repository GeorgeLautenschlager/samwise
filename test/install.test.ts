import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = process.cwd();

test('install and uninstall isolate project registration and preserve user data', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'samwise-install-test-'));
  const home = path.join(temp, 'home');
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  for (const item of ['lib/install-helper.js', 'config', 'agents']) {
    fs.cpSync(path.join(source, item), path.join(repo, item), { recursive: true });
  }
  fs.mkdirSync(path.join(repo, 'home'));
  fs.writeFileSync(path.join(repo, 'home/SYSTEM.md'), 'fixture system prompt');
  fs.mkdirSync(path.join(repo, 'bin'));
  const npmLog = path.join(temp, 'npm.log');
  fs.writeFileSync(path.join(repo, 'install.sh'), `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nnpm ci --prefix "$ROOT"\nnode "$ROOT/lib/install-helper.js" install "$ROOT"\n`);
  fs.chmodSync(path.join(repo, 'install.sh'), 0o755);
  fs.mkdirSync(path.join(temp, 'bin'));
  fs.writeFileSync(path.join(temp, 'bin/npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmLog}'\n`);
  fs.chmodSync(path.join(temp, 'bin/npm'), 0o755);
  const run = (script: string) => {
    const result = spawnSync(script, [], { cwd: repo, env: { ...process.env, HOME: home, PATH: `${path.join(temp, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };
  try {
    const pi = path.join(home, '.pi');
    const agent = path.join(pi, 'agent');
    fs.mkdirSync(path.join(agent, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ unrelated: { keep: true }, shared: { original: 1 } }));
    fs.writeFileSync(path.join(agent, 'auth.json'), 'auth sentinel');
    fs.writeFileSync(path.join(agent, 'sessions-sentinel'), 'session sentinel');
    fs.writeFileSync(path.join(agent, 'agents/foreman.md'), fs.readFileSync(path.join(repo, 'agents/foreman.md')));
    fs.writeFileSync(path.join(agent, 'agents/custom.md'), 'custom');

    const output = run('./install.sh');
    run('./install.sh');
    assert.equal(fs.readFileSync(npmLog, 'utf8').trim().split('\n').length, 2);
    const project = path.join(home, 'Samwise');
    const projectPi = path.join(project, '.pi');
    assert.ok(fs.lstatSync(projectPi).isDirectory());
    assert.ok(!fs.lstatSync(projectPi).isSymbolicLink());
    const projectSettings = JSON.parse(fs.readFileSync(path.join(projectPi, 'settings.json'), 'utf8'));
    assert.deepEqual(projectSettings.packages, [{ source: fs.realpathSync(repo) }]);
    assert.equal(fs.existsSync(path.join(pi, 'settings.json')), false);
    assert.equal(fs.readlinkSync(path.join(projectPi, 'SYSTEM.md')), fs.realpathSync(path.join(repo, 'home/SYSTEM.md')));
    assert.ok(fs.readdirSync(agent).some((name) => name.includes('.samwise-') && name.endsWith('.bak')));
    assert.equal(fs.existsSync(path.join(agent, 'agents/foreman.md')), false);

    const settingsFile = path.join(agent, 'settings.json');
    const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    installed.subagents.agentOverrides.foreman.model = 'custom/model';
    fs.writeFileSync(settingsFile, JSON.stringify(installed));
    const uninstall = spawnSync('node', [path.join(repo, 'lib/install-helper.js'), 'uninstall', fs.realpathSync(repo)], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.match(uninstall.stderr, /Leaving changed setting/);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(after.unrelated, { keep: true });
    assert.deepEqual(after.shared, { original: 1 });
    assert.equal(after.subagents.agentOverrides.foreman.model, 'custom/model');
    assert.equal(fs.existsSync(path.join(projectPi, 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(projectPi, 'SYSTEM.md')), false);
    assert.equal(fs.readFileSync(path.join(agent, 'auth.json'), 'utf8'), 'auth sentinel');
    assert.equal(fs.readFileSync(path.join(agent, 'sessions-sentinel'), 'utf8'), 'session sentinel');
    assert.ok(fs.existsSync(path.join(home, '.samwise/memory')));
    assert.equal(fs.readFileSync(path.join(agent, 'agents/custom.md'), 'utf8'), 'custom');
    assert.match(output, /Installed/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('installer skips absent SYSTEM and preserves an unrelated existing destination', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'samwise-install-conflict-'));
  const home = path.join(temp, 'home');
  const repo = path.join(temp, 'repo');
  try {
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    fs.cpSync(path.join(source, 'lib/install-helper.js'), path.join(repo, 'lib/install-helper.js'), { recursive: true });
    fs.cpSync(path.join(source, 'config'), path.join(repo, 'config'), { recursive: true });
    fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'home'));
    fs.writeFileSync(path.join(repo, 'home/SYSTEM.md'), 'fixture prompt');
    fs.mkdirSync(path.join(home, 'Samwise'), { recursive: true });
    const userSystem = path.join(home, 'Samwise/.pi/SYSTEM.md');
    fs.mkdirSync(path.dirname(userSystem), { recursive: true });
    fs.writeFileSync(userSystem, 'user-owned');
    const env = { ...process.env, HOME: home };
    const run = () => spawnSync('node', [path.join(repo, 'lib/install-helper.js'), 'install', repo], { env, encoding: 'utf8' });
    const conflict = run();
    assert.equal(conflict.status, 0, conflict.stderr);
    assert.match(conflict.stderr, /Leaving existing/);
    assert.equal(fs.readFileSync(userSystem, 'utf8'), 'user-owned');

    fs.unlinkSync(userSystem);
    fs.symlinkSync(path.join(home, 'missing-target'), userSystem);
    const brokenLink = run();
    assert.equal(brokenLink.status, 0, brokenLink.stderr);
    assert.match(brokenLink.stderr, /Leaving existing/);
    assert.equal(fs.readlinkSync(userSystem), path.join(home, 'missing-target'));
    const uninstall = spawnSync('node', [path.join(repo, 'lib/install-helper.js'), 'uninstall', repo], { env, encoding: 'utf8' });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.readlinkSync(userSystem), path.join(home, 'missing-target'));
    fs.rmSync(path.join(repo, 'home/SYSTEM.md'));
    const missing = run();
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Skipping SYSTEM.md/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
