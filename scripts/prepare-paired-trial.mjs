import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { inspectRuntimeInstallation } from '../server/config.mjs';
import { frozenTrials, readFrozenTrial, trialCards } from './launch-paired-trial.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const trialDocs = path.join(root, 'docs', '配对试用');
const tar = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonFile = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function unpack(archive, name, apps, label) {
  await run(tar, ['-xf', archive, '-C', apps], {windowsHide:true, timeout:180000});
  const destination = path.join(apps, label);
  await rename(path.join(apps, name), destination);
  return destination;
}

async function materialCopies(tasks) {
  return new Map(await Promise.all(tasks.map(async task => [task.id, await Promise.all(task.materials.map(async material => {
    const content = await readFile(path.join(trialDocs, material.path));
    assert.equal(sha256(content), material.sha256, '冻结材料摘要不符 ' + material.path);
    return {name:path.basename(material.path), content};
  }))])));
}

async function component(id, directory, python) {
  const {health, selection} = await inspectRuntimeInstallation(id, {root:directory, python});
  assert.ok(health.ok, id + ' 未通过依赖核对。' + health.reason);
  return {...selection, revision:health.revision, pythonVersion:health.python};
}

async function prepareSlot(out, slot, freeze, materials, settings) {
  const directory = path.join(out, slot.id);
  await mkdir(directory);
  await mkdir(path.join(directory, 'baseline'));
  await mkdir(path.join(directory, 'hyperBot'));
  await jsonFile(path.join(directory, 'baseline', 'settings.json'), settings);
  for (const [index, selection] of slot.order.entries()) {
    const [arm, id] = selection.split(':');
    const task = freeze.tasks.find(row => row.id === id);
    const round = path.join(directory, '第' + (index + 1) + '轮');
    const attachments = path.join(round, '材料');
    await mkdir(attachments, {recursive:true});
    for (const {name, content} of materials.get(id)) await writeFile(path.join(attachments, name), content, {flag:'wx'});
    for (const [name, content] of Object.entries(trialCards(task, freeze[arm].name))) {
      await writeFile(path.join(round, name), content, {flag:'wx'});
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32', '请在 Windows 上准备此轮试用。');
  const {values:args} = parseArgs({options:{
    'baseline-archive':{type:'string'}, 'candidate-archive':{type:'string'}, 'npm-cli':{type:'string'},
    workbench:{type:'string'}, python:{type:'string'}, hermes:{type:'string'}, 'hermes-python':{type:'string'},
    out:{type:'string'}, offline:{type:'boolean'}
  }});
  for (const name of ['baseline-archive', 'candidate-archive', 'workbench', 'python', 'hermes', 'out']) {
    assert.ok(args[name], '请提供 --' + name + '。');
  }
  const out = path.resolve(args.out);
  const baselineZip = await realpath(args['baseline-archive']);
  const candidateZip = await realpath(args['candidate-archive']);
  const npm = await realpath(args['npm-cli'] ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
  const [baselineHash, candidateHash, preparedTrials] = await Promise.all([
    digest(baselineZip), digest(candidateZip),
    Promise.all([...frozenTrials.keys()].map(trial => readFrozenTrial(trialDocs, trial)))
  ]);
  const selected = preparedTrials.find(item => item.parsed.freeze.hyperBot.sha256 === candidateHash);
  assert.ok(selected, 'Hyper Bot ZIP 摘要与任何冻结批次均不符。');
  const {freeze, slots} = selected.parsed;
  assert.equal(baselineHash, freeze.baseline.sha256, '现有入口 ZIP 摘要不符。');
  const [workbench, hermes, materials] = await Promise.all([
    component('workbench', args.workbench, args.python),
    component('hermes', args.hermes, args['hermes-python'] ?? args.python),
    materialCopies(freeze.tasks)
  ]);
  assert.equal(workbench.revision, freeze.workbenchCommit);

  await mkdir(out);
  const apps = path.join(out, 'apps');
  await mkdir(apps);
  const [baselineDir, candidateDir] = await Promise.all([
    unpack(baselineZip, 'self-media-bot', apps, 'baseline'),
    unpack(candidateZip, freeze.hyperBot.archive.slice(0, -4), apps, 'candidate')
  ]);
  assert.equal(await digest(path.join(candidateDir, '包内文件摘要.json')), selected.fileManifestSha256);
  const node = path.join(candidateDir, 'resources', 'node', 'node.exe');
  const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (args.offline) npmArgs.push('--offline');
  await run(process.execPath, [npm, ...npmArgs], {cwd:baselineDir, windowsHide:true, timeout:240000});
  for (const app of [baselineDir, path.join(candidateDir, 'resources', 'app')]) {
    const require = createRequire(path.join(app, 'package.json'));
    const sdk = await json(require.resolve('@deepseek-ai/dsh-sdk-client/package.json'));
    assert.equal(sdk.version, freeze.dsh, 'DSH SDK 与冻结版本不符。');
  }

  const baselineSettings = {
    model:freeze.model, baseUrl:new URL('/anthropic', freeze.upstream).href,
    maxTokens:freeze.maxOutputTokens, vision:false, protocol:'deepseek-messages',
    workbenchRoot:workbench.root, python:workbench.python
  };
  for (const slot of slots) await prepareSlot(out, slot, freeze, materials, baselineSettings);
  await writeFile(path.join(out, selected.name), selected.record, {flag:'wx'});
  await copyFile(path.join(root, 'scripts', 'launch-paired-trial.mjs'), path.join(out, 'launch.mjs'));
  const bundledNode = path.relative(out, node);
  await writeFile(path.join(out, 'Start-Trial.cmd'), '@echo off\r\n' +
    `"%~dp0${bundledNode}" "%~dp0launch.mjs" %*\r\n`, {flag:'wx'});
  await jsonFile(path.join(out, '试用配置.json'), {
    schema:1, checkedAt:new Date().toISOString(), trial:freeze.trial, templateSha256:selected.sha256,
    baseline:freeze.baseline, hyperBot:freeze.hyperBot, fileManifestSha256:selected.fileManifestSha256,
    dsh:freeze.dsh, baselineSettings, workbench, hermes,
    slots:slots.map(({id, order}) => ({id, order}))
  });
  console.log('已准备 ' + slots.length + ' 个场次 ' + out);
}

try { await main(); }
catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
}
