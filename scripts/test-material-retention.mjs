import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { modelFixture } from '../test/model-fixture.mjs';

const root=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{Workbench},{backupWorkspace,restoreWorkspace,verifyWorkspace}]=await Promise.all(
  ['http','workbench','workspace-archive'].map(name=>import(pathToFileURL(path.join(root,'server',name+'.mjs')))));
const fixture=await modelFixture();
const temporary=await mkdtemp(path.join(tmpdir(),'hyper-bot-retention-test-'));
const data=path.join(temporary,'工作区');
const raw='HB_PRIVATE_MATERIAL_'+randomUUID();
const prompt='HB_PRIVATE_PROMPT_'+randomUUID();
const draftText='HB_PRIVATE_DRAFT_'+randomUUID();
const filename='临时采访-'+raw.slice(-12)+'.txt';
const checks=[];
let host, cleanupPaused=true, cleanupFailures=0, holdCommit=null;
class WorkbenchUnderTest extends Workbench {
  async commit(...args) {
    const receipt=await super.commit(...args);
    if (holdCommit) {
      holdCommit.written(receipt);
      await holdCommit.release;
    }
    return receipt;
  }
  async clearMaterials(...args) {
    if (cleanupPaused) {
      ++cleanupFailures;
      throw Object.assign(new Error('Held workbench file'),{code:'EBUSY'});
    }
    return super.clearMaterials(...args);
  }
}
const open=when=>launch({options:{data:when ?? data,providerKey:'retention-test',upstream:fixture.origin},
  workbenchFactory:config=>new WorkbenchUnderTest(config)});
const headers={'Content-Type':'application/json','X-Hyper-Bot':'1'};
const url=(room,id='')=>'/rooms/'+room+'/materials'+(id?'/'+id:'');
const pass=text=>{checks.push(text);console.log('OK '+text);};
async function api(route,body,status) {
  const response=await fetch(host.origin+'/api'+route,body===undefined?undefined:{
    method:'POST',headers,body:JSON.stringify(body)
  });
  const answer=await response.json();
  if (status!==undefined) assert.equal(response.status,status,JSON.stringify(answer));
  else assert.ok(response.ok,JSON.stringify(answer));
  return answer;
}
const room=id=>api('/rooms/'+id);
const upload=(roomId,name,content)=>api(url(roomId),{name,content,authorized:true});
const decide=(run,status)=>api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow:true},status);
const start=(roomId,text,attachments,base=null)=>api('/rooms/'+roomId+'/runs',{
  text,attachments,base,clientRequestId:randomUUID(),authorized:true});
async function until(check,label,ms=12000) {
  const stop=Date.now()+ms;
  while (Date.now()<stop) {
    const result=await check();
    if (result) return result;
    await wait(140);
  }
  throw new Error('Timed out waiting for '+label);
}
async function stage(roomId,runId,status) {
  return until(async()=>{
    const current=await room(roomId);
    const run=current.runs.find(item=>item.id===runId);
    if (run.state===status) return {run,current};
    if (['succeeded','failed','interrupted','cancelled'].includes(run.state)) {
      throw new Error('Expected '+status+', received '+run.state+' '+run.error);
    }
  },status,90000);
}
async function saveScript(roomId,text,files) {
  const sent=await start(roomId,text,files);
  const pending=await stage(roomId,sent.id,'waiting_approval');
  await decide(pending.run,202);
  const saved=await stage(roomId,sent.id,'succeeded');
  return saved.current.artifacts.find(item=>item.run===sent.id);
}
async function matchingFiles(folder,needles) {
  const matches=[];
  const buffers=needles.map(word=>Buffer.from(word));
  for (const entry of await readdir(folder,{withFileTypes:true})) {
    const file=path.join(folder,entry.name);
    if (entry.isDirectory()) matches.push(...await matchingFiles(file,needles));
    else if (entry.isFile()) {
      const content=await readFile(file).catch(error=>{
        if(error.code!=='ENOENT') throw error;
      });
      if (content && buffers.some(word=>content.includes(word))) matches.push(file);
    }
  }
  return matches;
}

try {
  host=await open();
  const scriptId=(await api('/rooms',{botId:'media',revision:1,title:'书店授权演练',example:true})).id;
  const briefId=(await api('/rooms',{botId:'brief',revision:1,title:'简报期限演练',example:true})).id;
  let script=await room(scriptId);
  const seed=script.draft.attachments;
  const preserved=await saveScript(scriptId,script.draft.text,seed);
  const {id:material}=await upload(scriptId,filename,'第一行。\n'+raw);
  const route=url(scriptId,material);
  assert.equal((await api(route)).content.split('\n').at(-1),raw);
  assert.equal((await api(url(briefId,material)+'/revoke',{confirmed:true},403)).code,'material_scope');
  assert.equal((await api(route+'/deadline',{expiresAt:new Date(Date.now()-5000).toISOString()},422)).code,'material_deadline');
  await api(route+'/revoke',{confirmed:false},422);
  pass('期限校验、逐会话授权与明确确认');

  const withdrawn=await saveScript(scriptId,'请按这两份材料拟写。'+prompt,[material,seed[1]]);
  const working=await start(scriptId,'另一版口播。'+prompt,[material,seed[1]],withdrawn.id);
  const pending=(await stage(scriptId,working.id,'waiting_approval')).run;
  await api('/rooms/'+scriptId+'/draft',{text:draftText,attachments:[material,seed[1]],base:withdrawn.id});
  const exported=await api('/artifacts/'+withdrawn.id+'/export');
  assert.ok(exported.markdown.includes(raw));
  assert.ok(exported.manifest.sources.some(item=>item.name===filename));
  assert.deepEqual(exported.manifest.timing,withdrawn.timing);
  assert.equal(withdrawn.timing.method,'workbench-script-check');
  const projectFolder=path.join(data,'workbench','projects',withdrawn.receipt.project);
  const before=await matchingFiles(path.join(data,'workbench'),[raw,prompt]);
  assert.ok(before.some(file=>file.includes('contexts')) && before.some(file=>file.includes('attempts')) &&
    before.some(file=>file.includes('task-requests')) && before.some(file=>file.includes('sources')),before.join('\n'));
  const orphan=path.join(projectFolder,'agent','sources','E'+randomUUID().replaceAll('-','')+'.txt');
  await writeFile(orphan,'第一行。\n'+raw);
  const bridge=await fetch(host.app.workbench.base+'/api/status');
  assert.equal(bridge.status,403);
  pass('实际工作台原件、副本和私有连接均已核对');

  assert.equal((await api(route+'/revoke',{confirmed:true},202)).cleanup,'pending');
  await until(()=>cleanupFailures>0,'retryable Workbench cleanup failure');
  await decide(pending,409);
  assert.equal((await api(route,undefined,410)).code,'material_ended');
  for (const suffix of ['', '?format=filename']) {
    assert.equal((await api('/artifacts/'+withdrawn.id+'/export'+suffix,undefined,410)).code,'material_ended');
  }
  assert.equal((await api('/rooms/'+scriptId+'/runs',{text:'继续',attachments:[material,seed[1]],
    base:null,clientRequestId:randomUUID(),authorized:true},410)).code,'material_ended');
  script=await room(scriptId);
  assert.equal(script.runs.find(item=>item.id===pending.id).state,'cancelled');
  assert.ok(!script.runs.find(item=>item.id===pending.id).preview);
  assert.equal(script.artifacts[1].id,withdrawn.id);
  assert.equal(script.artifacts[1].result,undefined);
  assert.equal(script.artifacts[1].timing,undefined);
  assert.deepEqual(script.draft,{text:'',attachments:[seed[1]],base:null});
  assert.ok(![raw,prompt,filename,draftText].some(word=>JSON.stringify(script).includes(word)));
  assert.equal((await api('/artifacts/'+preserved.id+'/export')).manifest.id,preserved.id);
  await host.close();
  host=null;
  await assert.rejects(backupWorkspace(data,path.join(temporary,'禁止备份')),error=>error.code==='material_cleanup');
  pass('撤回即时关闭原文、分镜、续改、导出和待审批写入');

  cleanupPaused=false;
  host=await open();
  await until(()=>host.store.read().materials.find(file=>file.id===material)?.cleanup==='complete','durable cleanup');
  const context=await host.app.workbench.context(withdrawn.receipt.project);
  assert.ok(context.artifacts.find(item=>item.id===withdrawn.receipt.id).material_withdrawn);
  assert.ok(context.artifacts.find(item=>item.id===preserved.receipt.id).payload.segments.length===4);
  assert.ok(!context.sources.some(item=>item.origin==='hyper-bot:material:'+material));
  const keptFile=path.join(projectFolder,'agent','artifacts',preserved.receipt.id+'.json');
  await access(keptFile);
  assert.deepEqual(await matchingFiles(data,[raw,prompt,filename,draftText]),[]);
  const next=await saveScript(scriptId,'给当前授权材料另写一版。',seed);
  assert.equal(next.version,3);
  assert.equal(next.receipt.project,preserved.receipt.project);
  const readded=await upload(scriptId,filename,'第一行。\n'+raw);
  assert.notEqual(readded.id,material);
  pass('关机后重试清理，保留无关稿件，新授权产生新编号');

  let signalWrote, releaseCommit;
  const wrote=new Promise(resolve=>{signalWrote=resolve;});
  holdCommit={written:signalWrote,release:new Promise(resolve=>{releaseCommit=resolve;})};
  try {
    const racing=await start(scriptId,'检查写入与撤回的先后。'+prompt,[readded.id,seed[1]]);
    const approval=(await stage(scriptId,racing.id,'waiting_approval')).run;
    await decide(approval,202);
    const receipt=await Promise.race([wrote,wait(25000,null,{ref:false}).then(()=>{throw new Error('write did not reach receipt');})]);
    await api(url(scriptId,readded.id)+'/revoke',{confirmed:true},202);
    assert.equal((await room(scriptId)).runs.find(run=>run.id===racing.id).state,'saving');
    releaseCommit();
    const terminal=await stage(scriptId,racing.id,'succeeded');
    const tombstone=terminal.current.artifacts.find(item=>item.run===racing.id);
    assert.equal(tombstone.receipt.id,receipt.id);
    assert.equal(tombstone.result,undefined);
    assert.equal(tombstone.timing,undefined);
    await until(()=>host.store.read().materials.find(file=>file.id===readded.id)?.cleanup==='complete','in-flight write cleanup');
    assert.deepEqual(await matchingFiles(data,[raw,prompt]),[]);
    assert.equal((await api('/artifacts/'+tombstone.id+'/export',undefined,410)).code,'material_ended');
    pass('写入已发生后撤回，只登记回执并清理竞态副本');
  } finally {
    releaseCommit();
    holdCommit=null;
  }

  const expiryToken='HB_EXPIRES_'+randomUUID();
  const expiration=(await upload(briefId,'到期演练.txt','补充采访。\n'+expiryToken)).id;
  const base=(await room(briefId)).materials[0].id;
  const brief=await start(briefId,'请归纳两份材料的共同信息。',[expiration,base]);
  const saved=(await stage(briefId,brief.id,'succeeded')).current.artifacts.at(-1);
  const expRoute=url(briefId,expiration);
  const short=new Date(Date.now()+1400).toISOString();
  await api(expRoute+'/deadline',{expiresAt:short});
  await until(()=>host.store.read().materials.find(file=>file.id===expiration)?.cleanup==='complete','scheduled expiry');
  assert.equal((await api(expRoute,undefined,410)).code,'material_ended');
  assert.equal((await api('/artifacts/'+saved.id+'/export',undefined,410)).code,'material_ended');
  assert.equal((await room(briefId)).materials.find(file=>file.id===expiration).reason,'expired');
  assert.deepEqual(await matchingFiles(data,[expiryToken]),[]);
  pass('真实 Hermes 简报到期自动关闭并清理运行副本');

  const offlineToken='HB_OFFLINE_EXPIRY_'+randomUUID();
  const dormant=(await upload(briefId,'关机期限.txt',offlineToken)).id;
  const end=new Date(Date.now()+4600).toISOString();
  await api(url(briefId,dormant)+'/deadline',{expiresAt:end});
  await host.close();
  host=null;
  const priorBackup=path.join(temporary,'到期前备份');
  await backupWorkspace(data,priorBackup);
  assert.equal((await verifyWorkspace(priorBackup)).safeToRestore,true);
  await wait(Math.max(0,Date.parse(end)-Date.now()+80));
  const cloned=path.join(temporary,'禁止过期还原');
  assert.equal((await verifyWorkspace(priorBackup)).safeToRestore,false);
  await assert.rejects(restoreWorkspace(priorBackup,cloned),/含已到期或待清理的材料/);
  await assert.rejects(access(cloned),{code:'ENOENT'});
  host=await open();
  await until(()=>host.store.read().materials.find(file=>file.id===dormant)?.cleanup==='complete','boot expiry');
  await host.close();
  host=null;
  const afterBackup=path.join(temporary,'清理后备份');
  await backupWorkspace(data,afterBackup);
  const restored=path.join(temporary,'清理后还原');
  await restoreWorkspace(afterBackup,restored);
  await assert.rejects(access(path.join(restored,'runtime')),{code:'ENOENT'});
  assert.deepEqual(await matchingFiles(restored,[offlineToken,expiryToken]),[]);
  pass('启动清理关机期间到期的材料，拒绝从旧备份恢复到期副本');

  console.log(JSON.stringify({checks,project:withdrawn.receipt.project,
    retainedReceipt:preserved.receipt.id,withdrawnReceipt:withdrawn.receipt.id,continuedReceipt:next.receipt.id,
    preservedVersion:preserved.version,withdrawnVersion:withdrawn.version,continuedVersion:next.version,
    workbenchFilesBeforeCleanup:before.length,providerCalls:fixture.calls.length,fixture:true}));
} finally {
  await host?.close();
  await fixture.close();
}

