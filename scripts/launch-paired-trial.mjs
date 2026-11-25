import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const frozenTrials = new Map([
  ['hyper-bot-m1-dev51-r1', {
    name:'现场记录-dev.51.json',
    sha256:'68a1e25280e33c66d1e3e4ab5a6cb817e15d7002b3f1a304fb6f9b95ea9cc7fa',
    fileManifestSha256:'e075b5de46d3967049165ee3f9a20c941e4905a262574063a225525fc3d4fec0'
  }],
  ['hyper-bot-m1-dev56-r1', {
    name:'现场记录-dev.56.json',
    sha256:'f7458903e013c674ef4acbc7036ee57a733e7248cdf5e0be1a5169af66902490',
    fileManifestSha256:'56f7d2ae10298d4c72a8ca98b501ddcc93c06566ef2b095b310a335453172b60'
  }]
]);
const systemVariables = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'programfiles', 'programfiles(x86)',
  'programdata', 'userprofile', 'homedrive', 'homepath', 'number_of_processors', 'processor_architecture'
]);

async function preparedPath(directory, ...parts) {
  const expected = path.join(directory, ...parts);
  assert.equal(path.relative(expected, await realpath(expected)), '', '试用文件须位于准备时的原目录。' + parts.join('/'));
  return expected;
}

async function preparedFile(directory, ...parts) {
  const file = await preparedPath(directory, ...parts);
  assert.ok((await lstat(file)).isFile(), '试用记录须为普通文件。' + parts.join('/'));
  return file;
}

export async function readFrozenTrial(directory, trial) {
  const definition = frozenTrials.get(trial);
  assert.ok(definition, '找不到该批次的冻结样表。');
  const record = await readFile(await preparedFile(directory, definition.name));
  assert.equal(sha256(record), definition.sha256, '现场样表与冻结版不符。');
  const parsed = JSON.parse(record);
  assert.equal(parsed.freeze.trial, trial, '试用批次与冻结版不符。');
  return {...definition, record, parsed};
}

async function trialLayout(directory) {
  directory = await realpath(directory);
  const setup = await preparedFile(directory, '试用配置.json').then(json);
  const supported = await readFrozenTrial(directory, setup.trial);
  const {freeze, slots} = supported.parsed;
  assert.equal(setup.templateSha256, supported.sha256, '现场样表与冻结版不符。');
  assert.equal(setup.fileManifestSha256, supported.fileManifestSha256, '候选包文件清单摘要与冻结版不符。');
  assert.deepEqual(setup.baseline, freeze.baseline, '现有入口与冻结发行件不符。');
  assert.deepEqual(setup.hyperBot, freeze.hyperBot, 'Hyper Bot 与冻结发行件不符。');
  assert.equal(setup.dsh, freeze.dsh, 'DSH 与冻结版本不符。');
  assert.equal(setup.workbench.revision, freeze.workbenchCommit, '工作台与冻结版本不符。');
  assert.deepEqual(setup.slots, slots.map(({id,order}) => ({id,order})), '场次和分组顺序与冻结版不符。');
  assert.deepEqual(setup.baselineSettings, {
    model:freeze.model, baseUrl:new URL('/anthropic', freeze.upstream).href,
    maxTokens:freeze.maxOutputTokens, vision:false, protocol:'deepseek-messages',
    workbenchRoot:setup.workbench.root, python:setup.workbench.python
  }, '两路入口的模型或工作台配置与冻结版不符。');
  return {directory, setup, freeze};
}

export function trialCards(task, name) {
  const files = task.materials.map(({path:file}) => `- [${path.basename(file)}](材料/${path.basename(file)})`).join('\n');
  return {
    '首稿任务.md':`# ${task.title}\n\n入口为 ${name} 首页。\n\n${task.firstPrompt}\n\n## 材料\n\n${files}\n`,
    '续改任务.md':`# ${task.title}续改\n\n${task.revisionPrompt}\n`
  };
}

async function verifyRoundCards(directory, card, task, name) {
  const relative = path.relative(directory, card);
  const materialFolder = await preparedPath(directory, relative, '材料');
  const expectedFiles = task.materials.map(item => path.basename(item.path)).sort();
  assert.deepEqual((await readdir(materialFolder)).sort(), expectedFiles, '场次材料列表与冻结版不符。' + relative);
  await Promise.all([
    ...task.materials.map(async item => {
      const file = path.basename(item.path);
      const content = await readFile(await preparedFile(directory, relative, '材料', file));
      assert.equal(sha256(content), item.sha256, '场次材料摘要与冻结版不符。' + relative + '/' + file);
    }),
    ...Object.entries(trialCards(task, name)).map(async ([file, expected]) => {
      const content = await readFile(await preparedFile(directory, relative, file));
      assert.ok(content.equals(Buffer.from(expected)), '场次任务卡与冻结版不符。' + relative + '/' + file);
    })
  ]);
}

async function plannedRound({directory,setup,freeze}, slot, round, port, open) {
  const baseline = setup.baselineSettings;
  const selection = setup.slots.find(row => row.id === slot)?.order[round - 1];
  assert.ok(selection && [1, 2].includes(round), '请指定已准备的场次 HB01 至 HB08 和轮次 1 或 2。');
  const [arm, task] = selection.split(':');
  const data = await preparedPath(directory, slot, arm);
  const candidate = path.join(directory, 'apps', 'candidate');
  const card = path.join(directory, slot, '第' + round + '轮');
  await verifyRoundCards(directory, card, freeze.tasks.find(row => row.id === task), freeze[arm].name);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemVariables.has(key.toLowerCase())));
  Object.assign(env, {
    APPDATA: path.join(data, 'roaming'), LOCALAPPDATA: path.join(data, 'local'),
    TEMP: path.join(data, 'temp'), TMP: path.join(data, 'temp')
  });

  if (arm === 'baseline') {
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, '端口须在 1024 至 65535 之间。');
    const settings = await json(await preparedFile(directory, slot, arm, 'settings.json'));
    for (const [key, value] of Object.entries(baseline)) {
      assert.equal(settings[key], value, '现有入口设置与冻结值不符：' + key);
    }
    const cwd = path.join(directory, 'apps', 'baseline');
    const argv = [path.join(cwd, 'dist', 'server', 'index.js')];
    if (open) argv.push('--open');
    Object.assign(env, {SELF_MEDIA_BOT_HOME: data, SELF_MEDIA_BOT_PORT: String(port)});
    return {arm, file:path.join(candidate, 'resources', 'node', 'node.exe'), argv, cwd, env, card};
  }

  assert.equal(arm, 'hyperBot');
  Object.assign(env, {
    HYPER_BOT_DATA_DIR: data, HYPER_BOT_MODEL: baseline.model,
    HYPER_BOT_WORKBENCH_ROOT: baseline.workbenchRoot, HYPER_BOT_WORKBENCH_PYTHON: baseline.python,
    HYPER_BOT_HERMES_ROOT: setup.hermes.root, HYPER_BOT_HERMES_PYTHON: setup.hermes.python,
    SELF_MEDIA_STATE_DIR: path.join(data, 'legacy-state'), SELF_MEDIA_DATA_DIR: path.join(data, 'legacy-data')
  });
  return {arm, file:path.join(candidate, 'Hyper Bot.exe'), argv:[], cwd:candidate, env, card};
}

export async function planRound(directory, slot, round, port, open = false) {
  return plannedRound(await trialLayout(directory), slot, round, port, open);
}

export async function checkTrial(directory) {
  const layout = await trialLayout(directory);
  const {directory:root, setup, freeze} = layout;
  const candidate = ['apps', 'candidate'];
  const app = [...candidate, 'resources', 'app'];
  const baseline = ['apps', 'baseline'];
  const [manifest, earlier, current, earlierDsh, currentDsh, domain] = await Promise.all([
    preparedFile(root, ...candidate, '包内文件摘要.json').then(readFile),
    preparedFile(root, ...baseline, 'package.json').then(json),
    preparedFile(root, ...app, 'package.json').then(json),
    preparedFile(root, ...baseline, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'package.json').then(json),
    preparedFile(root, ...app, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'package.json').then(json),
    preparedFile(root, ...baseline, 'workbench.manifest.json').then(json),
    preparedFile(root, ...baseline, 'dist', 'server', 'index.js'),
    preparedFile(root, ...candidate, 'Hyper Bot.exe'),
    preparedFile(root, ...candidate, 'resources', 'node', 'node.exe')
  ]);
  assert.equal(sha256(manifest), setup.fileManifestSha256, '候选包文件清单摘要不符。');
  assert.equal(earlier.version, freeze.baseline.version, '现有入口版本不符。');
  assert.equal(current.version, freeze.hyperBot.version, 'Hyper Bot 版本不符。');
  assert.equal(earlierDsh.version, freeze.dsh, '现有入口的 DSH 版本不符。');
  assert.equal(currentDsh.version, freeze.dsh, 'Hyper Bot 的 DSH 版本不符。');
  assert.equal(domain.commit, freeze.workbenchCommit, '现有入口的工作台提交不符。');
  const plans = await Promise.all(setup.slots.flatMap(({id}) => [1,2].map(round => plannedRound(layout,id,round,13210,false))));
  assert.equal(new Set(plans.map(plan => plan.env.TEMP)).size, plans.length, '两轮试用共用了工作区。');
  const config = await preparedFile(root, ...app, 'server', 'config.mjs');
  const {inspectRuntimeInstallation} = await import(pathToFileURL(config).href);
  const runtimes = Object.fromEntries(await Promise.all(['workbench','hermes'].map(async name => {
    const local = setup[name];
    const {health} = await inspectRuntimeInstallation(name, local);
    assert.ok(health.ok, name + ' 未通过本机组件核对。' + health.reason);
    assert.equal(health.revision, local.revision, name + ' 本机提交与准备记录不符。');
    return [name, {revision:health.revision, pythonVersion:health.python}];
  })));
  return {
    trial:freeze.trial, mode:'local-preflight', platform:process.platform, release:release(), arch:process.arch,
    rounds:plans.length, model:freeze.model, maxOutputTokens:freeze.maxOutputTokens,
    baseline:earlier.version, hyperBot:current.version, dsh:freeze.dsh, runtimes
  };
}

async function main() {
  const {values} = parseArgs({options:{
    slot:{type:'string'}, round:{type:'string'}, port:{type:'string', default:'13210'}, open:{type:'boolean'}, check:{type:'boolean'}
  }});
  const directory = fileURLToPath(new URL('.', import.meta.url));
  if (values.check) {
    assert.ok(!values.slot && !values.round && !values.open, '预检只需 --check。');
    console.log(JSON.stringify(await checkTrial(directory), null, 2));
    return;
  }
  const launch = await planRound(directory, values.slot, Number(values.round), Number(values.port), values.open);
  await Promise.all([launch.env.TEMP, launch.env.LOCALAPPDATA, launch.env.APPDATA]
    .map(dir => mkdir(dir, {recursive:true})));
  console.log('本轮任务卡与材料 ' + launch.card);
  const child = spawn(launch.file, launch.argv, {cwd:launch.cwd, env:launch.env, stdio:'inherit'});
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
