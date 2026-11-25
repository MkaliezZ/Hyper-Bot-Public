import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Store } from '../server/store.mjs';
import { workspaceLock } from '../server/workspace-lock.mjs';
import { backupWorkspace, restoreWorkspace, verifyWorkspace } from '../server/workspace-archive.mjs';
import { cleanupWorkspace } from '../server/workspace-retirement.mjs';

async function fixture() {
  const base=await mkdtemp(path.join(tmpdir(),'hyper-bot-archive-test-'));
  const source=path.join(base,'源工作区');
  const project=path.join(source,'workbench','projects','test');
  await mkdir(project,{recursive:true});
  await writeFile(path.join(project,'project.json'),'{"project":"fixture"}');
  await mkdir(path.join(source,'runtime'));
  await writeFile(path.join(source,'runtime','cache.json'),'{"fakeTestContent":"cache"}');
  const store=new Store(path.join(source,'hyper-bot.sqlite'));
  await store.init();
  store.change(state=>{state.marker='archive-test';});
  store.close();
  return {base,source};
}

test('workspace backup is fenced by the live writer lock',async()=>{
  const {base,source}=await fixture();
  const destination=path.join(base,'busy');
  const release=await workspaceLock(source);
  try {
    await assert.rejects(backupWorkspace(source,destination),{code:'workspace_busy'});
    await assert.rejects(access(destination),{code:'ENOENT'});
  } finally {await release();}
});

test('backup restores the persisted state and Workbench files to a new directory',async()=>{
  const {base,source}=await fixture();
  const archive=path.join(base,'备份');
  const restored=path.join(base,'还原');
  await assert.rejects(backupWorkspace(source,path.join(source,'nested')),/与来源分开/);
  await backupWorkspace(source,archive);
  const check=await verifyWorkspace(archive);
  assert.equal(check.manifest.version,1);
  assert.deepEqual(check.manifest.files.map(item=>item.path),['hyper-bot.sqlite','workbench/projects/test/project.json']);
  await restoreWorkspace(archive,restored);
  const store=new Store(path.join(restored,'hyper-bot.sqlite'));
  try { assert.equal(store.read().marker,'archive-test'); } finally { store.close(); }
  assert.equal(await readFile(path.join(restored,'workbench/projects/test/project.json'),'utf8'),'{"project":"fixture"}');
  await assert.rejects(access(path.join(restored,'runtime')),{code:'ENOENT'});
  await assert.rejects(restoreWorkspace(archive,restored),/目标目录已存在/);
});

test('changed backup file prevents restoring even when its size matches',async()=>{
  const {base,source}=await fixture();
  const archive=path.join(base,'备份');
  const restored=path.join(base,'新目录');
  await backupWorkspace(source,archive);
  await writeFile(path.join(archive,'workbench/projects/test/project.json'),'{"project":"corrupt"}');
  await assert.rejects(restoreWorkspace(archive,restored),/摘要校验失败/);
  await assert.rejects(access(restored),{code:'ENOENT'});
});

test('backup retention blocks restoring at expiry and requires exact cleanup confirmation',
  {skip:process.platform!=='win32'},async t=>{
    const {base,source}=await fixture();
    const retained=path.join(base,'限期备份'), legacy=path.join(base,'旧式备份');
    const restored=path.join(base,'还原');
    const until=new Date(Date.now()+3600000).toISOString();
    await backupWorkspace(source,legacy);
    const created=await backupWorkspace(source,retained,{retainUntil:until});
    assert.equal(created.manifest.format,'hyper-bot-workspace/2');
    assert.equal(created.manifest.retainUntil,until);
    assert.equal((await verifyWorkspace(legacy)).manifest.format,'hyper-bot-workspace/1');
    assert.equal((await verifyWorkspace(retained)).safeToRestore,true);
    await assert.rejects(cleanupWorkspace(retained,'backup'),/已经到期/);

    t.mock.timers.enable({apis:['Date'],now:Date.parse(until)});
    const check=await verifyWorkspace(retained);
    assert.equal(check.retainUntil,until);
    assert.equal(check.retentionEnded,true);
    assert.equal(check.safeToRestore,false);
    await assert.rejects(restoreWorkspace(retained,restored),/留存期限已结束/);
    await assert.rejects(access(restored),{code:'ENOENT'});
    await assert.rejects(cleanupWorkspace(legacy,'backup'),/明确留存期限/);
    const preview=await cleanupWorkspace(retained,'backup');
    assert.equal(preview.status,'preview');
    await assert.rejects(cleanupWorkspace(retained,'backup','1'.repeat(64)),/重新预检/);
    await access(retained);
    const result=await cleanupWorkspace(retained,'backup',preview.confirmation);
    assert.equal(result.status,'removed');
    await assert.rejects(access(retained),{code:'ENOENT'});
    await access(path.join(source,'hyper-bot.sqlite'));
    assert.equal((await verifyWorkspace(legacy)).safeToRestore,true);
  });

test('retirement fences a live workspace, changed inventory and external junctions',
  {skip:process.platform!=='win32'},async ()=>{
    const {base,source}=await fixture();
    const backup=path.join(base,'备份');
    const external=path.join(base,'独立工作台');
    const junction=path.join(source,'runtime','external');
    await mkdir(external);
    await writeFile(path.join(external,'独立原件.txt'),'external original');
    await backupWorkspace(source,backup);
    const release=await workspaceLock(source);
    try { await assert.rejects(cleanupWorkspace(source,'workspace'),{code:'workspace_busy'}); }
    finally { await release(); }

    const extra=path.join(source,'我的导出.md');
    await writeFile(extra,'keep this export');
    await assert.rejects(cleanupWorkspace(source,'workspace'),/未识别/);
    await unlink(extra);
    await symlink(external,junction,'junction');
    await assert.rejects(cleanupWorkspace(source,'workspace'),/链接或特殊文件/);
    await unlink(junction);

    const old=await cleanupWorkspace(source,'workspace');
    const modified=path.join(source,'runtime','cache.json');
    await writeFile(modified,'{"fakeTestContent":"later"}');
    await assert.rejects(cleanupWorkspace(source,'workspace',old.confirmation),/重新预检/);
    assert.match(await readFile(modified,'utf8'),/later/);
    const current=await cleanupWorkspace(source,'workspace');
    const result=await cleanupWorkspace(source,'workspace',current.confirmation);
    assert.equal(result.status,'removed');
    assert.equal(result.directory,await realpath(base).then(dir=>path.join(dir,path.basename(source))));
    assert.equal(result.version,1);
    await assert.rejects(access(source),{code:'ENOENT'});
    assert.equal(await readFile(path.join(external,'独立原件.txt'),'utf8'),'external original');
    const restored=path.join(base,'恢复副本');
    await restoreWorkspace(backup,restored);
    const store=new Store(path.join(restored,'hyper-bot.sqlite'));
    try { assert.equal(store.read().marker,'archive-test'); } finally { store.close(); }
  });

test('cleanup can resume after a staged file fails to be removed',
  {skip:process.platform!=='win32'},async ()=>{
    const {base,source}=await fixture();
    const preview=await cleanupWorkspace(source,'workspace');
    const entry=new URL('../server/workspace-retirement.mjs',import.meta.url);
    const code=`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import path from 'node:path';
      const unlink=fs.promises.unlink;
      fs.promises.unlink=file=>{
        if (path.basename(file)==='cache.json' && file.includes('.HyperBot-cleanup-')) {
          return Promise.reject(new Error('simulated removal error'));
        }
        return unlink(file);
      };
      syncBuiltinESMExports();
      const {cleanupWorkspace}=await import(process.argv[3]);
      await cleanupWorkspace(process.argv[1],'workspace',process.argv[2]);
    `;
    const exec=promisify(execFile);
    await assert.rejects(exec(process.execPath,['--input-type=module','-e',code,source,preview.confirmation,entry.href]),
      error=>error.stderr.includes('simulated removal error'));
    await assert.rejects(access(source),{code:'ENOENT'});
    const pending=(await readdir(base)).find(name=>name.startsWith('.HyperBot-cleanup-'));
    assert.ok(pending);
    await access(path.join(base,pending,'payload','runtime','cache.json'));
    assert.equal((await cleanupWorkspace(source,'workspace',preview.confirmation)).status,'removed');
    await assert.rejects(access(path.join(base,pending)),{code:'ENOENT'});
  });

