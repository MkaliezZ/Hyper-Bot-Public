import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { at } from './store.mjs';
import { root } from './config.mjs';
import { workspaceLock } from './workspace-lock.mjs';
import { assertArchiveSafe, hasUnclearedMaterials } from './materials.mjs';
import { id } from './contracts.mjs';

const database = 'hyper-bot.sqlite';
const format = 'hyper-bot-workspace/1';
const retainedFormat = 'hyper-bot-workspace/2';
const knownWorkbenchPaths = ['workbench/projects', 'workbench/sessions', 'workbench/task-requests','teaching-trial/assets','teaching-trial/artifacts'];
const trialDB='teaching-trial/m0.sqlite';
const manifestFile = 'manifest.json';

export async function hashWorkspaceFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function existing(target) {
  try { return await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function relativeEntry(key) {
  const parts = key.split('/');
  if (!parts.every(part => part && part !== '.' && part !== '..' && !/[\\:\u0000-\u001f]/.test(part))) return false;
  const entry=parts[0]==='groups'&&id.safeParse(parts[1]).success?parts.slice(2).join('/'):key;
  return entry===database || entry===trialDB || knownWorkbenchPaths.some(prefix=>entry.startsWith(prefix+'/'));
}
const fileEntry = z.strictObject({ path:z.string().refine(relativeEntry), bytes:z.number().int().nonnegative(), sha256:z.string().regex(/^[a-f0-9]{64}$/) });
const manifestFields = {
  createdAt:z.iso.datetime(),appVersion:z.string(),version:z.number().int().nonnegative(),
  workbench:z.boolean(),files:z.array(fileEntry).nonempty()
};
const backupManifest = z.discriminatedUnion('format',[
  z.strictObject({format:z.literal(format),...manifestFields}),
  z.strictObject({format:z.literal(retainedFormat),...manifestFields,retainUntil:z.iso.datetime()})
]);
const local = (base, relative) => path.join(base, ...relative.split('/'));

async function tree(parent, relative, result) {
  const file = local(parent, relative);
  const info = await existing(file);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of (await readdir(file)).sort()) await tree(parent, relative+'/'+name, result);
  } else if (info.isFile() && relativeEntry(relative)) {
    result.push({ path:relative, bytes:info.size, sha256:await hashWorkspaceFile(file) });
  } else {
    throw new Error('工作区含有未支持的链接或文件类型。请核对 '+relative+'。');
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep));
}

async function separate(source, rawTarget) {
  const target = path.resolve(rawTarget);
  const physical = path.join(await realpath(path.dirname(target)), path.basename(target));
  if (inside(source, physical) || inside(physical, source)) throw new Error('请选择与来源分开的新目录。');
  if (await existing(physical)) throw new Error('目标目录已存在。请选择新的目录名称。');
  return physical;
}

export function checkedDatabase(file) {
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    if (check.quick_check !== 'ok') throw new Error('工作区 SQLite 校验失败。');
    const state = JSON.parse(db.prepare('SELECT body FROM workspace WHERE key=1').get().body);
    if (!Number.isSafeInteger(state.version) || !Array.isArray(state.runs) || !Array.isArray(state.artifacts)
        || !Array.isArray(state.conversations)) throw new Error('该数据库没有 Hyper Bot 工作区。');
    db.prepare('SELECT count(1) FROM events').get();
    return {db,state};
  } catch (error) {
    db.close();
    throw error;
  }
}

async function copyEntry(source, target, entry) {
  const from = local(source, entry.path);
  const to = local(target, entry.path);
  await mkdir(path.dirname(to), {recursive:true,mode:0o700});
  await copyFile(from, to, constants.COPYFILE_EXCL);
  if (await hashWorkspaceFile(to) !== entry.sha256) throw new Error('复制后的摘要校验失败。请核对 '+entry.path+'。');
}

async function archiveGroups(source,state) {
  const ids=z.array(z.object({id})).parse(state.workspaceGroups??[]).map(group=>group.id);
  if (new Set(ids).size!==ids.length) throw new Error('工作区分组清单重复。');
  if (ids.length) await requireDirectory(source,'groups');
  for (const key of ids) await requireDirectory(source,'groups/'+key);
  return ids.map(key=>'groups/'+key+'/');
}

async function requireDirectory(source,relative) {
  const info=await existing(local(source,relative));
  if (!info?.isDirectory()||info.isSymbolicLink()) throw new Error('工作区分组目录无效。请核对 '+relative+'。');
}

async function checkpointTrial(source,prefix) {
  const base=local(source,prefix+'teaching-trial');
  const info=await existing(base);
  if(!info)return;
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('试用教培目录无效。');
  const file=local(source,prefix+trialDB),dbInfo=await existing(file);
  if(!dbInfo)return;
  if(!dbInfo.isFile()||dbInfo.isSymbolicLink())throw new Error('试用教培数据库无效。');
  const db=new DatabaseSync(file);
  try {if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy)throw new Error('教培数据正在使用。');}
  finally{db.close();}
}
async function snapshotDatabase(source,target,relative) {
  const from=local(source,relative), to=local(target,relative);
  const info=await existing(from);
  if (!info?.isFile()||info.isSymbolicLink()) throw new Error('找不到工作区数据库。请核对 '+relative+'。');
  const {db,state}=checkedDatabase(from);
  try {
    assertArchiveSafe(state);
    if (state.conversations.some(room=>room.specialistUploads?.length)) {
      throw new Error('工作区有尚未登记的专项素材。请先执行任务或移除暂存素材，再重新备份。');
    }
    if (relative===database) await mkdir(target,{mode:0o700});
    else await mkdir(path.dirname(to),{recursive:true,mode:0o700});
    await backup(db,to);
  } finally {db.close();}
  const snapshot=new DatabaseSync(to);
  try {snapshot.exec('PRAGMA journal_mode=DELETE');}
  finally {snapshot.close();}
  return state;
}

async function archiveFiles(source,prefix,entries) {
  const trial=await existing(local(source,prefix+'teaching-trial'));
  if(trial&&(!trial.isDirectory()||trial.isSymbolicLink()))throw new Error('试用教培目录无效。');
  await tree(source,prefix+trialDB,entries);
  const workbench=await existing(local(source,prefix+'workbench'));
  if (workbench && (!workbench.isDirectory()||workbench.isSymbolicLink())) throw new Error('工作台目录类型无效。');
  for (const name of knownWorkbenchPaths) await tree(source,prefix+name,entries);
}

export async function backupWorkspace(source, target, {retainUntil} = {}) {
  if (retainUntil !== undefined) {
    const value=z.iso.datetime({offset:true}).safeParse(retainUntil);
    if (!value.success || !(Date.parse(value.data)>Date.now())) {
      throw new Error('备份留存截止须为未来的 ISO 8601 时间，并带时区。');
    }
    retainUntil=new Date(value.data).toISOString();
  }
  source = await realpath(source);
  target = await separate(source, target);
  if (!(await existing(local(source,database)))?.isFile()) throw new Error('找不到原工作区数据库。');
  const release = await workspaceLock(source);
  try {
    const state=await snapshotDatabase(source,target,database);
    const groups=await archiveGroups(source,state);
    const entries = [];
    await tree(target,database,entries);
    const assets = [];
    await checkpointTrial(source,'');
    await archiveFiles(source,'',assets);
    for (const entry of assets) await copyEntry(source,target,entry);
    for (const prefix of groups) {
      const releaseGroup=await workspaceLock(local(source,prefix.slice(0,-1)));
      try {
        await snapshotDatabase(source,target,prefix+database);
        await tree(target,prefix+database,entries);
        const groupAssets=[];
        await checkpointTrial(source,prefix);
        await archiveFiles(source,prefix,groupAssets);
        for (const entry of groupAssets) await copyEntry(source,target,entry);
        assets.push(...groupAssets);
      } finally {await releaseGroup();}
    }
    const {version} = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    const manifest={format:retainUntil?retainedFormat:format,createdAt:at(),appVersion:version,
      version:state.version,workbench:assets.length>0,files:[...entries,...assets],
      ...(retainUntil?{retainUntil}:{})};
    await writeFile(local(target,manifestFile),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return { target,manifest,retainUntil:retainUntil??null };
  } finally { await release(); }
}

export async function verifyWorkspace(archive) {
  const source = await realpath(archive);
  if (!(await existing(local(source,manifestFile)))?.isFile()) throw new Error('备份缺少完成清单。');
  const manifest=backupManifest.parse(JSON.parse(await readFile(local(source,manifestFile),'utf8')));
  const retainUntil=manifest.retainUntil??null;
  const keys = manifest.files.map(entry=>entry.path.toLowerCase());
  if (new Set(keys).size !== keys.length || !keys.includes(database)) throw new Error('备份文件清单不一致。');
  const present = [];
  await tree(source,database,present);
  await archiveFiles(source,'',present);
  const {db,state} = checkedDatabase(local(source,database));
  db.close();
  const groups=await archiveGroups(source,state);
  let uncleared=hasUnclearedMaterials(state);
  for (const prefix of groups) {
    await tree(source,prefix+database,present);
    await archiveFiles(source,prefix,present);
    const {db:groupDB,state:groupState}=checkedDatabase(local(source,prefix+database));
    groupDB.close();
    if (hasUnclearedMaterials(groupState)) uncleared=true;
  }
  const byPath = new Map(present.map(value=>[value.path,value]));
  if (present.length !== manifest.files.length || manifest.workbench !== present.some(row=>!row.path.endsWith('/'+database)&&row.path!==database)) {
    throw new Error('备份文件数量不一致。');
  }
  for (const expected of manifest.files) {
    const actual = byPath.get(expected.path);
    if (actual?.sha256 !== expected.sha256 || actual?.bytes !== expected.bytes)
      throw new Error('备份文件摘要校验失败。请核对 '+expected.path+'。');
  }
  if (state.version !== manifest.version) throw new Error('备份的工作区版本与清单不符。');
  const retentionEnded=retainUntil!==null&&Date.parse(retainUntil)<=Date.now();
  return {source,manifest,retainUntil,retentionEnded,safeToRestore:!retentionEnded&&!uncleared};
}

export async function restoreWorkspace(archive,target) {
  const {source,manifest,safeToRestore,retentionEnded} = await verifyWorkspace(archive);
  if (retentionEnded) throw new Error('这份备份的留存期限已结束。请选择仍在留存期的备份。');
  if (!safeToRestore) throw new Error('这份备份含已到期或待清理的材料。请在原工作区完成清理并重新备份。');
  target = await separate(source,target);
  await mkdir(target,{mode:0o700});
  for (const entry of manifest.files) await copyEntry(source,target,entry);
  return {target,version:manifest.version,workbench:manifest.workbench};
}

