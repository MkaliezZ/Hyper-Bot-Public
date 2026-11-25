import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { artifactBundle } from '../server/export.mjs';
import { payloadHash, planDigest } from '../server/workbench-protocol.mjs';
import { readFrozenTrial } from './launch-paired-trial.mjs';

const trialDocs = fileURLToPath(new URL('../docs/配对试用/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const projectId = /^[a-f0-9]{32}$/;
const artifactId = /^A[a-f0-9]{32}$/;
const sourceId = /^E[a-f0-9]{32}$/;
const normalize = value => value.replace(/\r\n?/g, '\n').trim();
const productNames = /Hyper\s*Bot|Self[\s-]*Media[\s-]*(?:Bot|Workbench)|自媒体\s*(?:Bot|口播)|DSH\s*(?:Web\s*Host|SDK)|Hermes\s*ACP/gi;
const machinePaths = /(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|[a-z]:[\\/])[^\s<>"“”]*/gi;

async function inside(parent, ...parts) {
  const expected = path.join(parent, ...parts);
  const actual = await realpath(expected);
  assert.equal(path.relative(expected, actual), '', '试用文件须在已准备的原目录内。');
  return actual;
}

async function file(parent, ...parts) {
  const name = await inside(parent, ...parts);
  const info = await lstat(name);
  assert.ok(info.isFile() && info.size <= 64 * 1024 * 1024, '无法读取试用记录 ' + path.basename(name));
  return readFile(name);
}

async function chooseProject(data, chosen) {
  if (chosen) assert.match(chosen, projectId, '工作台项目编号格式不符。');
  let projects;
  try { projects = await inside(data, 'workbench', 'projects'); }
  catch (error) {
    if (error.code === 'ENOENT' && !chosen) return null;
    throw error;
  }
  if (!chosen) {
    const rows = (await readdir(projects, {withFileTypes:true})).filter(row => projectId.test(row.name));
    assert.ok(rows.length <= 1, '此入口有多个项目，请指定本次试用的项目编号。');
    if (!rows.length) return null;
    chosen = rows[0].name;
  }
  const directory = await inside(projects, chosen);
  const raw = await file(directory, 'project.json');
  const project = JSON.parse(raw);
  assert.equal(project.id, chosen, '工作台项目编号与目录不符。');
  return {directory, raw, project};
}

async function scriptVersions(directory, project) {
  const seen = new Set(), versions = [];
  for (let id = project.agent_heads?.script; id; ) {
    assert.ok(versions.length < 2, '此项目有两版以上分镜，请使用本次试用的独立项目。');
    assert.match(id, artifactId, '分镜版本编号格式不符。');
    assert.ok(!seen.has(id), '分镜版本链包含重复记录。');
    seen.add(id);
    const raw = await file(directory, 'agent', 'artifacts', id + '.json');
    const entry = JSON.parse(raw);
    assert.equal(entry.id, id, '分镜版本编号与文件不符。');
    assert.equal(entry.stage, 'script', '分镜版本链包含其他成果。');
    assert.equal(entry.validation?.accepted, true, '分镜尚无工作台保存回执。');
    versions.push({entry, sha256:sha256(raw)});
    id = entry.supersedes;
  }
  return versions.reverse();
}

async function authorizeCandidate(data, project, versions) {
  if (!versions.length) return;
  const database = new DatabaseSync(await inside(data, 'hyper-bot.sqlite'), {readOnly:true});
  try {
    const state = JSON.parse(database.prepare('SELECT body FROM workspace WHERE key=1').get().body);
    for (const {entry} of versions) {
      const record = state.artifacts.find(row => row.kind === 'script' &&
        row.receipt?.project === project.id && row.receipt?.id === entry.id);
      assert.ok(record, '此版分镜在来源会话中不可导出。');
      artifactBundle({read:() => state}, record.id, true);
      const run = state.runs.find(item => item.id === record.run);
      const plan = run?.plan;
      assert.ok(run?.state === 'succeeded' && run.artifact === record.id &&
        plan?.body && plan.project === project.id &&
        run.approval?.digest === plan.digest && planDigest(plan) === plan.digest,
        '此版分镜缺少可核对的原任务写入计划。');
      const submission = plan.original ? plan.submission : plan;
      assert.ok(submission?.body, '此版分镜缺少原项目提交记录。');
      const saved = Object.fromEntries(Object.keys(submission.body).map(key => [key, entry[key]]));
      assert.equal(payloadHash(saved), submission.digest, '工作台稿件与原任务获准写入的内容不符。');
      assert.equal(entry.created_at, record.receipt.publishedAt, '工作台保存时间与原任务回执不符。');
    }
  } finally { database.close(); }
}

async function workbenchSources(directory, project, task, materials) {
  const allowed = new Map(materials.map(row => [row.normalizedSha256, row]));
  // The baseline stores task instructions as sources. Only the two frozen
  // instructions are eligible, with their role visible to the reviewer.
  const instructions = new Map([task.firstPrompt, task.revisionPrompt].map(prompt =>
    [sha256(normalize(prompt)), {name:'任务要求 · 用于核对题意', content:Buffer.from(prompt)}]));
  const matchedMaterials = new Set();
  const witnessed = new Map();
  for (const source of project.agent_sources ?? []) {
    assert.match(source.id, sourceId, '工作台材料编号格式不符。');
    const material = allowed.get(source.sha256);
    const instruction = source.label === '本轮用户要求' && instructions.get(source.sha256);
    assert.ok((material && material.name === source.label) || instruction, '工作台项目含非本任务的材料。');
    const bytes = await file(directory, 'agent', 'sources', source.id + '.txt');
    assert.equal(sha256(normalize(bytes.toString('utf8'))), source.sha256, '工作台材料原文与冻结材料不符。');
    witnessed.set(source.id, material ?? instruction);
    if (material) matchedMaterials.add(material.name);
  }
  assert.equal(matchedMaterials.size, materials.length, '项目未保存本轮的两份冻结材料。');
  return witnessed;
}

function renderScript({payload, unresolved}, sources, label) {
  assert.ok(Array.isArray(payload.segments) && payload.segments.length, '保存的分镜没有正文。');
  const claims = new Map(payload.claims.map(claim => [claim.id, claim]));
  const lines = [label, '分镜时间为计划值。请另记实际口播试读时长。', ''];
  for (const [index, row] of payload.segments.entries()) {
    assert.ok(Number.isFinite(row.start) && Number.isFinite(row.end), '分镜时间码缺失。');
    lines.push('第 ' + (index + 1) + ' 镜 · ' + row.start + '–' + row.end + ' 秒',
      '口播', row.spoken, '画面', row.visual, '字幕', row.subtitle || '沿用口播');
    const citations = row.claim_ids.flatMap(id => {
      const claim = claims.get(id);
      assert.ok(claim, '分镜引用了稿件中不存在的声明。');
      return claim.evidence.map(ref => {
        const material = sources.get(ref.source_id);
        assert.ok(material && normalize(material.content.toString('utf8')).includes(ref.quote),
          '稿件中的引用无法在对应冻结原文中定位。');
        return '【' + material.name + '】' + ref.quote;
      });
    });
    lines.push('引用', ...(citations.length ? [...new Set(citations)] : ['未提供引文']), '');
  }
  const notes = [...new Set([...(unresolved ?? []), ...(payload.production_limits ?? [])])];
  if (notes.length) lines.push('待确认与执行说明', ...notes, '');
  if (payload.cta) lines.push('行动提示', payload.cta, '');
  let hidden = 0;
  const conceal = () => { hidden++; return '［已隐去入口或本机地址］'; };
  const manuscript = lines.join('\n').replace(productNames, conceal).replace(machinePaths, conceal);
  return {manuscript, hidden};
}

async function prepareCase(trial, slot, assignment, round, freeze, chosen) {
  const [arm, taskId] = assignment.split(':');
  const task = freeze.tasks.find(row => row.id === taskId);
  const directory = await inside(trial, slot);
  const data = await inside(directory, arm);
  const materials = await Promise.all(task.materials.map(async row => {
    const name = path.basename(row.path);
    const content = await file(directory, '第' + round + '轮', '材料', name);
    assert.equal(sha256(content), row.sha256, '场次材料摘要不符 ' + name);
    return {...row, name, content};
  }));
  const selected = await chooseProject(data, chosen);
  const versions = selected ? await scriptVersions(selected.directory, selected.project) : [];
  if (arm === 'hyperBot') await authorizeCandidate(data, selected?.project, versions);
  const sources = versions.length ? await workbenchSources(selected.directory, selected.project, task, materials) : new Map();
  const manuscripts = versions.map(({entry}, index) => renderScript(entry, sources, ['首稿', '改稿'][index]));
  if (selected) {
    assert.deepEqual(await file(selected.directory, 'project.json'), selected.raw, '读取期间项目发生变化，请待本轮结束后重试。');
  }
  if (arm === 'hyperBot') await authorizeCandidate(data, selected?.project, versions);
  return {arm, task, materials, manuscripts, project:selected?.project.id ?? null,
    versions:versions.map(({entry, sha256}, index) => ({id:entry.id, sha256, concealed:manuscripts[index].hidden})),
    code:'R-' + randomBytes(8).toString('hex')};
}

async function writeReview(out, cases, freeze, slot, rehearsal) {
  await mkdir(out);
  const publicDir = path.join(out, '评阅包');
  await mkdir(publicDir);
  const scores = ['# 口播稿盲评', '', ...(rehearsal?['工程演练样例', '']:[]),
    '按展示编号逐份检查。请把开场、显著事实和待确认事项对回给定原文，分别记录稿件的实际试读秒数和可交付判断。结合首稿查看末镜改动，核对其余镜次与时间码。缺稿、找回首稿和操作用时由现场组织者记录。',
    '', '| 稿件编号 | 试读秒数 | 四镜和时间码 | 可交付 | 事实错配及对应原文 |',
    '| --- | --- | --- | --- | --- |'];
  const mapping = [];
  for (const [index, item] of cases.entries()) {
    const label = String(index + 1).padStart(2, '0') + '-' + item.code;
    const dest = path.join(publicDir, label);
    await mkdir(dest);
    await writeFile(path.join(dest, '任务.txt'), [item.task.title, '', item.task.firstPrompt, '',
      item.task.revisionPrompt, '', '本次收到 ' + item.versions.length + ' 版已保存分镜。', ''].join('\n'), {flag:'wx'});
    for (const material of item.materials) await writeFile(path.join(dest, material.name), material.content, {flag:'wx'});
    for (const [revision, row] of item.manuscripts.entries()) {
      const name = ['首稿', '改稿'][revision];
      await writeFile(path.join(dest, name + '.txt'), row.manuscript, {flag:'wx'});
      scores.push('| ' + label + ' ' + name + ' |  |  |  |  |');
    }
    mapping.push({code:label, arm:item.arm, task:item.task.id, project:item.project, versions:item.versions});
  }
  await writeFile(path.join(publicDir, '评阅表.md'), scores.join('\n') + '\n', {flag:'wx'});
  await writeFile(path.join(out, '组织者映射.json'), JSON.stringify({
    schema:1, trial:freeze.trial, slot, rehearsal, createdAt:new Date().toISOString(), cases:mapping
  }, null, 2) + '\n', {flag:'wx', mode:0o600});
}

async function main() {
  const {values} = parseArgs({options:{
    trial:{type:'string'}, slot:{type:'string'}, out:{type:'string'}, rehearsal:{type:'boolean'},
    'baseline-project':{type:'string'}, 'hyperbot-project':{type:'string'}
  }});
  assert.ok(values.trial && values.slot && values.out, '请提供 --trial、--slot 与 --out。');
  const trial = await realpath(values.trial);
  const setup = JSON.parse(await file(trial, '试用配置.json'));
  const selected = await readFrozenTrial(trialDocs, setup.trial);
  const {freeze, slots} = selected.parsed;
  assert.equal(setup.templateSha256, selected.sha256, '现场样表与本轮冻结版不符。');
  assert.equal(setup.fileManifestSha256, selected.fileManifestSha256, '候选包文件清单摘要与冻结版不符。');
  assert.deepEqual(setup.baseline, freeze.baseline, '现有入口与冻结发行件不符。');
  assert.deepEqual(setup.hyperBot, freeze.hyperBot, '候选入口与冻结发行件不符。');
  assert.equal(setup.workbench?.revision, freeze.workbenchCommit, '工作台提交与冻结版本不符。');
  const slot = slots.find(row => row.id === values.slot);
  assert.ok(slot, '请指定 HB01 至 HB08。');
  assert.deepEqual(setup.slots.find(row => row.id === slot.id)?.order, slot.order, '场次顺序不符。');
  const cases = [];
  for (const [index, assignment] of slot.order.entries()) {
    const project = assignment.startsWith('baseline:') ? values['baseline-project'] : values['hyperbot-project'];
    cases.push(await prepareCase(trial, slot.id, assignment, index + 1, freeze, project));
  }
  if (randomInt(2)) cases.reverse();
  const out = path.resolve(values.out);
  await writeReview(out, cases, freeze, slot.id, Boolean(values.rehearsal));
  console.log('已准备盲评包 ' + path.join(out, '评阅包'));
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode=1; }
