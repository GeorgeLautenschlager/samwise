import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [action, rootArg] = process.argv.slice(2);
const root = path.resolve(rootArg);
const home = os.homedir();
const piHome = path.join(home, '.pi');
const agentDir = path.join(piHome, 'agent');
const userProject = path.join(home, 'Samwise');
const settingsPath = path.join(agentDir, 'settings.json');
const projectSettingsPath = path.join(userProject, '.pi', 'settings.json');
const source = root;
const packageSystem = path.join(root, 'home', 'SYSTEM.md');
const userSystem = path.join(userProject, '.pi', 'SYSTEM.md');
const configPaths = ['config/subagents.settings.json', 'config/pi.settings.json'];

function mkdir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeJson(file, value) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isOwnSystemSymlink() {
  try {
    const stat = fs.lstatSync(userSystem);
    return stat.isSymbolicLink()
      && path.resolve(path.dirname(userSystem), fs.readlinkSync(userSystem)) === packageSystem;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function mergeConfig(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = target[key];
      if (!current || typeof current !== 'object' || Array.isArray(current)) target[key] = {};
      mergeConfig(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function loadConfig() {
  const config = {};
  for (const relative of configPaths) mergeConfig(config, readJson(path.join(root, relative)));
  return config;
}

function setPackageEntry(settings, remove = false) {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const matching = (entry) => typeof entry === 'string'
    ? path.resolve(userProject, entry) === source
    : entry?.source && path.resolve(entry.source) === source;
  if (remove) {
    settings.packages = packages.filter((entry) => !matching(entry));
    if (settings.packages.length === 0) delete settings.packages;
  } else if (!packages.some(matching)) {
    settings.packages = [...packages, { source }];
  }
}

function backupSettings() {
  if (!fs.existsSync(settingsPath)) return;
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${settingsPath}.samwise-${timestamp}.bak`;
  fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
  console.log(`Backup retained: ${backupPath} (restore manually if needed).`);
}

function install() {
  const config = loadConfig();
  mkdir(agentDir);
  const before = readJson(settingsPath);
  const after = structuredClone(before);
  mergeConfig(after, config);
  if (!equal(before, after)) {
    backupSettings();
    writeJson(settingsPath, after);
  }

  mkdir(path.join(userProject, '.pi'));
  const projectSettings = readJson(projectSettingsPath);
  const projectUpdated = structuredClone(projectSettings);
  setPackageEntry(projectUpdated);
  if (!equal(projectSettings, projectUpdated)) writeJson(projectSettingsPath, projectUpdated);

  mkdir(userProject);
  mkdir(path.dirname(userSystem));
  if (fs.existsSync(packageSystem)) {
    try {
      fs.lstatSync(userSystem);
      if (!isOwnSystemSymlink()) {
        console.warn(`Leaving existing ${userSystem}; it is not this package's symlink.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') fs.symlinkSync(packageSystem, userSystem);
      else throw error;
    }
  } else {
    console.log(`Skipping SYSTEM.md: ${packageSystem} is absent; supply your own if needed.`);
  }

  mkdir(path.join(home, '.samwise', 'memory'));
  console.log('Installed. On first Pi open, trust ~/Samwise when prompted.');
}

function uninstall() {
  const projectSettings = readJson(projectSettingsPath);
  const updatedProject = structuredClone(projectSettings);
  setPackageEntry(updatedProject, true);
  if (!equal(projectSettings, updatedProject)) {
    if (Object.keys(updatedProject).length === 0) fs.rmSync(projectSettingsPath, { force: true });
    else writeJson(projectSettingsPath, updatedProject);
  }

  if (isOwnSystemSymlink()) fs.unlinkSync(userSystem);
  console.log('Uninstalled project-scope package registration and this package\'s SYSTEM.md symlink. Global ~/.pi/agent/settings.json was left untouched because its keys cannot be distinguished from pre-existing user settings; memory, auth, sessions, and user agents were also left untouched.');
}

if (action === 'install') install();
else if (action === 'uninstall') uninstall();
else throw new Error('Expected install or uninstall');
