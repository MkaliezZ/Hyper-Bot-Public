import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha } from './contracts.mjs';
import { checkedDatabase, hashWorkspaceFile, verifyWorkspace } from './workspace-archive.mjs';
import { workspaceLock } from './workspace-lock.mjs';

const database = 'hyper-bot.sqlite';
const journal = 'cleanup-plan.json';
const completedJournal = 'cleanup-completed.json';
const confirmationPattern = /^[a-f0-9]{64}$/;
const workspaceFiles = new Set([database,'workspace-guard.sqlite','host.lock']);
const workspaceFolders = new Set(['desktop','runtime','workbench']);

async function existing(file) {
  try { return await lstat(file,{bigint:true}); }
  catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
}

function identity(stat) {
  return [stat.dev.toString(),stat.ino.toString()].join('/');
}

async function ownedDirectory(directory) {
  const stat=await existing(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || path.relative(directory,await realpath(directory))) {
    throw new Error('清理路径必须是实际目录，请核对 '+directory+'。');
  }
  return identity(stat);
}

function controlledFile(entry) {
  return workspaceFiles.has(entry) ||
    /^(hyper-bot|workspace-guard)\.sqlite-(wal|shm|journal)$/.test(entry);
}

function inside(parent, child) {
  const relative=path.relative(parent,child);
  return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
}

async function validateWorkspaceRoot(directory) {
  if (!(await existing(path.join(directory,database)))?.isFile()) throw new Error('找不到 Hyper Bot 工作区数据库。');
  for (const name of ['SELF_MEDIA_STATE_DIR','SELF_MEDIA_DATA_DIR','HYPER_BOT_WORKBENCH_ROOT','HYPER_BOT_HERMES_ROOT']) {
    const value=process.env[name];
    if (value && inside(directory,await realpath(value).catch(()=>path.resolve(value)))) {
      throw new Error('清理目录内包含已配置的独立组件或项目。请先核对 '+name+'。');
    }
  }
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if ((controlledFile(entry.name)&&entry.isFile()) || (workspaceFolders.has(entry.name)&&entry.isDirectory())) continue;
    throw new Error('工作区包含未识别的项目，请先移动到独立目录。'+entry.name);
  }
}

async function inventory(directory, skipLock = false) {
  const rows=[];
  async function visit(parent,prefix) {
    for (const name of (await readdir(parent)).sort()) {
      if (skipLock && !prefix && (name==='host.lock' || name==='workspace-guard.sqlite-journal')) continue;
      const file=path.join(parent,name), key=prefix+name;
      const stat=await lstat(file,{bigint:true});
      if (stat.isDirectory()) {
        const dirId=await ownedDirectory(file);
        await visit(file,key+'/');
        rows.push({path:key,type:'directory',identity:dirId});
      } else if (stat.isFile()) {
        // SQLite changes the shared-memory index even during read-only checks.
        const sharedIndex=!prefix && /^(hyper-bot|workspace-guard)\.sqlite-shm$/.test(name);
        rows.push({path:key,type:'file',identity:identity(stat),bytes:Number(stat.size),
          sha256:sharedIndex?null:await hashWorkspaceFile(file)});
      } else {
        throw new Error('清理路径内含链接或特殊文件，请核对 '+key+'。');
      }
    }
  }
  await visit(directory,'');
  return rows;
}

async function describe(directory,kind) {
  const rootId=await ownedDirectory(directory);
  if (kind==='backup') {
    const {manifest,retentionEnded,retainUntil}=await verifyWorkspace(directory);
    if (!retentionEnded) throw new Error('只可清理有明确留存期限、且已经到期的备份。');
    const allowed=new Set(['manifest.json',...manifest.files.map(row=>row.path)]);
    const rows=await inventory(directory);
    if (rows.some(row=>row.type==='file'?!allowed.has(row.path):
      ![...allowed].some(name=>name.startsWith(row.path+'/')))) {
      throw new Error('备份目录包含清单以外的内容。请先移出其它文件。');
    }
    return {schema:1,kind,directory,rootId,rows,summary:{version:manifest.version,retainUntil}};
  }

  await validateWorkspaceRoot(directory);
  const release=await workspaceLock(directory);
  try {
    const {db,state}=checkedDatabase(path.join(directory,database));
    db.close();
    const rows=await inventory(directory,true);
    return {schema:1,kind,directory,rootId,rows,summary:{version:state.version,
      conversations:state.conversations.length,artifacts:state.artifacts.length+(state.retiredArtifacts?.length??0)}};
  } finally { await release(); }
}

function report(plan,confirmation) {
  const files=plan.rows.filter(row=>row.type==='file');
  return {action:plan.kind==='backup'?'purge-expired':'retire',directory:plan.directory,...plan.summary,
    files:files.length,bytes:files.reduce((total,row)=>total+row.bytes,0),confirmation};
}

async function deletePlanned(stage,data,plan) {
  if (await ownedDirectory(data)!==plan.rootId) throw new Error('待清理目录与原计划不符。');
  const expected=new Map(plan.rows.map(row=>[row.path,JSON.stringify(row)]));
  const present=await inventory(data);
  if (present.some(row=>expected.get(row.path)!==JSON.stringify(row))) {
    throw new Error('待清理目录有新内容或文件已变化。请人工核对 '+data+'。');
  }
  // The inventory is in postorder and includes only regular files and physical directories.
  for (const row of present) {
    const file=path.join(data,...row.path.split('/'));
    const remove=row.type==='file'?unlink:rmdir;
    await remove(file).catch(error=>{if (error.code!=='ENOENT') throw error;});
  }
  await rename(path.join(stage,journal),path.join(stage,completedJournal));
}

async function finishCleanup(stage,data,plan) {
  if (await existing(data)) {
    if (await ownedDirectory(data)!==plan.rootId) throw new Error('待清理目录与原计划不符。');
    await rmdir(data);
  }
  await unlink(path.join(stage,completedJournal));
  await rmdir(stage);
}

export async function cleanupWorkspace(raw,kind,confirmation) {
  if (process.platform!=='win32') throw new Error('此清理流程使用 Windows 的工作区锁和目录移动。');
  const requested=path.resolve(raw);
  if (requested===path.parse(requested).root) throw new Error('请选择具体的 Hyper Bot 数据或备份目录。');
  const directory=path.join(await realpath(path.dirname(requested)),path.basename(requested));
  if (confirmation===undefined) {
    const plan=await describe(directory,kind);
    return {...report(plan,sha(JSON.stringify(plan))),status:'preview'};
  }
  if (!confirmationPattern.test(confirmation)) throw new Error('请使用预检返回的完整确认码。');

  const stage=path.join(path.dirname(directory),'.HyperBot-cleanup-'+confirmation.slice(0,24));
  const data=path.join(stage,'payload');
  const journalFile=path.join(stage,journal);
  let plan,completed=false;
  if (await existing(stage)) {
    await ownedDirectory(stage);
    completed=!!await existing(path.join(stage,completedJournal));
    const currentJournal=completed?completedJournal:journal;
    if ((await readdir(stage)).some(name=>name!=='payload' && name!==currentJournal)) {
      throw new Error('清理暂存目录内有未识别内容。请核对 '+stage+'。');
    }
    const recorded=path.join(stage,currentJournal);
    if (!(await existing(recorded))?.isFile()) throw new Error('找不到当前清理计划。请核对 '+stage+'。');
    plan=JSON.parse(await readFile(recorded,'utf8'));
    if (sha(JSON.stringify(plan))!==confirmation || plan.kind!==kind || path.relative(plan.directory,directory)) {
      throw new Error('待清理计划与确认码或源路径不同。');
    }
  } else {
    plan=await describe(directory,kind);
    if (sha(JSON.stringify(plan))!==confirmation) throw new Error('目录内容已变化，请重新预检。');
    await mkdir(stage,{mode:0o700});
    await writeFile(journalFile,JSON.stringify(plan),{flag:'wx',mode:0o600});
  }

  try {
    if (!completed) {
      if (!(await existing(data))) {
        const current=await describe(directory,kind);
        if (sha(JSON.stringify(current))!==confirmation) throw new Error('目录内容已变化，请重新预检。');
        // An active SQLite connection or Electron file handle prevents the Windows rename.
        // No file is removed before the directory is detached into its own staging location.
        await rename(directory,data);
      }
      await deletePlanned(stage,data,plan);
    }
    await finishCleanup(stage,data,plan);
  } catch (error) {
    throw new Error(error.message+' 清理记录位于 '+stage+'。可核对后重试同一命令。',{cause:error});
  }
  return {...report(plan,confirmation),status:'removed'};
}
