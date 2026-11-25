import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';
import { startFixtureWorkbench } from '../test/isolated-workbench.mjs';

const self=fileURLToPath(import.meta.url);
const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{configFor,processEnvironment},{Workbench},{makeSamples}]=await Promise.all(['http','config','workbench','registry']
  .map(name=>import(pathToFileURL(join(root,'server',name+'.mjs')))));

function crashAt(data,run) {
  const proof=run.generation;
  writeFileSync(join(data,'fixture-crash.json'),JSON.stringify({run:run.id,session:run.engineSession,project:run.project,
    state:run.state,provider:proof?.provider,checkpoint:!!proof?.result,storedPreparation:!!proof?.preparation}));
  process.kill(process.pid,'SIGKILL');
}

async function serve([data,upstream,mode,offline]) {
  let host, triggered=false;
  if (mode==='transcript') {
    const original=globalThis.fetch;
    globalThis.fetch=async (resource,options)=>{
      const reply=await original(resource,options);
      if (!triggered && reply.ok && new URL(resource).pathname==='/api/session/events') {
        const packet=await reply.clone().json();
        if (packet.result?.value?.records?.some(row=>row.event?.type==='turn/end'&&row.event.data?.reason?.kind==='completed')) {
          const run=host?.store.read().runs.find(item=>item.state==='running'&&item.generation?.provider);
          if (run) {
            triggered=true;
            crashAt(data,run);
          }
        }
      }
      return reply;
    };
  }
  host=await launch({options:{data,upstream,providerKey:offline==='no-key'?'':'hyper-bot-crash-test'}});
  if (['checkpoint','expired','stopping'].includes(mode)) {
    host.store.onChange(()=>{
      if (triggered) return;
      const run=host.store.read().runs.find(item=>mode==='stopping'
        ?item.state==='stopping':item.state==='running'&&item.generation?.result);
      if (run) {
        triggered=true;
        if (mode==='expired') {
          host.store.change(state=>{
            const file=state.materials.find(row=>row.id===run.materialIds[0]);
            file.expiresAt='2000-01-01T00:00:00.000Z';
          });
        }
        crashAt(data,run);
      }
    });
  }
  process.send({origin:host.origin});
  process.on('message',async message=>{
    if(message==='close') {
      await host.close();
      process.disconnect();
    }
  });
}

if (process.argv[2]==='--fixture-host') {
  await serve(process.argv.slice(3));
} else {
  await runCases();
}

async function runCases() {
  const model=await modelFixture();
  const checks=[];
  const pass=note=>{checks.push(note);console.log('OK '+note);};
  const created=new Set();
  const scratch=await mkdtemp(join(tmpdir(),'hb-generation-crash-'));

  async function launchChild(data,mode='normal',offline=false,environment={}) {
    const child=fork(self,['--fixture-host',data,model.origin,mode,offline?'no-key':'fixture-key'],{
      execArgv:[],windowsHide:true,cwd:dirname(self),env:{...process.env,...environment},stdio:['ignore','inherit','inherit','ipc']
    });
    created.add(child);
    child.on('error',()=>{});
    const exited=once(child,'close').finally(()=>created.delete(child));
    try {
      const {origin}=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Fixture host startup timeout')),22000);
        child.once('message',packet=>{clearTimeout(timer);resolve(packet);});
        child.once('close',()=>{clearTimeout(timer);reject(new Error('Fixture host closed before listening'));});
      });
      return {origin,exited,kill:()=>child.kill('SIGKILL'),async close() {
        if (!child.connected) return exited;
        child.send('close',()=>{});
        const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
        try {await exited;} finally {clearTimeout(timer);}
      }};
    } catch(error) {
      if (child.exitCode===null) child.kill('SIGKILL');
      throw error;
    }
  }

  let active;
  async function request(route,body,status) {
    const send=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
    const response=await fetch(active.origin+'/api'+route,{...send,signal:AbortSignal.timeout(6500)});
    const result=await response.json();
    if (status) assert.equal(response.status,status,JSON.stringify(result));
    else assert.ok(response.ok,JSON.stringify(result));
    return result;
  }
  const room=id=>request('/rooms/'+id);
  const create=async (bot='media')=>(await request('/rooms',{botId:bot,revision:1,title:'街角书店',example:true},201)).id;

  async function start(roomId,text) {
    const {draft}=await room(roomId);
    return request('/rooms/'+roomId+'/runs',{text:text??draft.text,attachments:draft.attachments,
      clientRequestId:randomUUID(),authorized:true},202);
  }
  async function waitFor(read,test,seconds=36) {
    const timing=AbortSignal.timeout(seconds*1000);
    for (;;) {
      timing.throwIfAborted();
      const value=await read();
      if (test(value)) return value;
      await delay(135,null,{signal:timing});
    }
  }
  async function stage(roomId,runId,desired) {
    return waitFor(()=>room(roomId),value=>{
      const item=value.runs.find(row=>row.id===runId);
      if (item?.state===desired) return true;
      if (['failed','interrupted','cancelled','succeeded'].includes(item?.state)) {
        throw new Error('Expected '+desired+', got '+item.state+': '+item.error);
      }
      return false;
    });
  }
  function awaitCrash(data) {
    return Promise.race([
      active.exited,
      delay(95000,null,{ref:false}).then(()=>{throw new Error('Expected abrupt host exit before the run deadline');})
    ]).then(()=>readFile(join(data,'fixture-crash.json'),'utf8')).then(JSON.parse);
  }
  async function nativeScenario(data,createRoom=create,environment={}) {
    active=await launchChild(data,'transcript',false,environment);
    const id=await createRoom();
    const run=await start(id);
    const witness=await awaitCrash(data);
    assert.equal(witness.run,run.id);
    assert.equal(witness.state,'running');
    assert.equal(witness.checkpoint,false);
    assert.equal(witness.provider.requests,1);
    assert.equal(witness.storedPreparation,true);
    return {id,run,witness};
  }

  async function browserCheck(id) {
    const install=process.argv.includes('--no-ui')?null:process.env.HYPER_BOT_TEST_PLAYWRIGHT;
    if (!install) return;
    const {chromium}=createRequire(import.meta.url)(install);
    const browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
    const errors=[];
    const folder=process.env.HYPER_BOT_TEST_SCREENSHOTS;
    try {
      for (const width of [1440,390]) {
        const page=await browser.newPage({viewport:{width,height:width===1440?900:844},reducedMotion:width===390?'reduce':'no-preference'});
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(active.origin+'/#chat/'+id);
        await page.getByText('已找回本轮分镜。请核对预览，确认是否保存到原项目。',{exact:true}).waitFor();
        await page.getByRole('button',{name:'允许本次写入'}).waitFor();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
        if(width===1440&&folder) {
          await mkdir(folder,{recursive:true});
          await page.screenshot({path:join(folder,'桌面-找回分镜审批.png'),animations:'disabled'});
        }
        await page.close();
      }
      assert.deepEqual(errors,[]);
      pass('桌面和窄屏会话标明分镜已找回，用户可以核对预览并决定是否写入');
    } finally {
      await browser.close();
    }
  }

  try {
    const scriptData=join(scratch,'cold-script');
    const script=await nativeScenario(scriptData);
    const callsAfterScript=model.calls.length;
    const locked=createServer();
    await new Promise((resolve,reject)=>{
      locked.once('error',reject);
      locked.listen(0,'127.0.0.1',resolve);
    });
    const persisted=()=>{
      const db=new DatabaseSync(join(scriptData,'hyper-bot.sqlite'),{readOnly:true});
      try {
        const {body}=db.prepare('SELECT body FROM workspace WHERE key=1').get();
        return {
          run:JSON.parse(body).runs.find(row=>row.id===script.run.id),
          events:db.prepare('SELECT seq,kind,data FROM events WHERE run=? ORDER BY seq').all(script.run.id)
        };
      } finally { db.close(); }
    };
    const beforeBind=persisted();
    try {
      await assert.rejects(launch({port:locked.address().port,options:{data:scriptData,upstream:model.origin,providerKey:''}}),
        {code:'EADDRINUSE'});
      assert.deepEqual(persisted(),beforeBind,'Failed listener startup must leave original run and events intact');
      assert.equal(model.calls.length,callsAfterScript);
      pass('端口不可用时服务启动明确失败，原运行、持久事件及模型请求保持原状，释放端口后才读取恢复');
    } finally {
      await new Promise(resolve=>locked.close(resolve));
    }
    active=await launchChild(scriptData,'normal',true);
    const proposal=await stage(script.id,script.run.id,'waiting_approval');
    const restored=proposal.runs[0];
    assert.equal(restored.engineSession,script.witness.session);
    assert.equal(restored.engineRecovered,true);
    assert.equal(restored.approval.project,script.witness.project);
    assert.equal(restored.preview.segments.length,4);
    assert.equal(proposal.artifacts.length,0);
    assert.equal('generation' in restored,false);
    const wbDir=join(scriptData,'workbench','projects',script.witness.project,'agent','artifacts');
    assert.deepEqual(await readdir(wbDir).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error)),[]);
    await browserCheck(script.id);
    await request('/runs/'+script.run.id+'/decide',{id:restored.approval.id,digest:restored.approval.digest,allow:true},202);
    const scriptDone=await stage(script.id,script.run.id,'succeeded');
    assert.equal(scriptDone.artifacts.length,1);
    assert.equal(scriptDone.artifacts[0].run,script.run.id);
    assert.equal(scriptDone.artifacts[0].receipt.project,script.witness.project);
    const resultEvents=await request('/runs/'+script.run.id+'/events');
    assert.deepEqual(resultEvents.map(event=>event.seq),resultEvents.map((_,index)=>index+1));
    assert.ok(resultEvents.some(event=>event.kind==='state'&&event.data.state==='recovering'));
    assert.equal(resultEvents.filter(event=>event.kind==='generation_recovered')[0].data.method,'dsh_transcript');
    assert.equal(model.calls.length,callsAfterScript);
    await active.close(); active=await launchChild(scriptData,'normal',true);
    assert.equal((await room(script.id)).artifacts.length,1);
    await active.close();
    pass('实际 DSH Web Host 已完成但界面未收到，强制退出后从原 Session 冷读分镜，确认后在原项目只保存一次');

    const briefData=join(scratch,'hermes');
    active=await launchChild(briefData,'checkpoint');
    const briefRoom=await create('brief');
    const brief=await start(briefRoom);
    const checkpoint=await awaitCrash(briefData);
    assert.equal(checkpoint.run,brief.id);
    assert.equal(checkpoint.checkpoint,true);
    assert.equal(checkpoint.provider.requests,1);
    const callsAfterBrief=model.calls.length;
    active=await launchChild(briefData,'normal',true);
    const briefDone=await stage(briefRoom,brief.id,'succeeded');
    assert.equal(briefDone.artifacts[0].run,brief.id);
    assert.equal(briefDone.runs[0].usage.requests,1);
    assert.ok(briefDone.artifacts[0].result.points.every(point=>point.evidence.length>0));
    const localEvents=await request('/runs/'+brief.id+'/events');
    assert.equal(localEvents.find(event=>event.kind==='generation_recovered').data.method,'checkpoint');
    assert.equal(model.calls.length,callsAfterBrief);
    await active.close();
    pass('真实 Hermes ACP 的完整结果已落盘时，强制退出后可以在原会话恢复带引用简报和用量');

    const expiredData=join(scratch,'expired');
    active=await launchChild(expiredData,'expired');
    const expiringRoom=await create('brief');
    const expiring=await start(expiringRoom);
    assert.equal((await awaitCrash(expiredData)).checkpoint,true);
    const beforeExpired=model.calls.length;
    active=await launchChild(expiredData,'normal',true);
    const ended=await stage(expiringRoom,expiring.id,'cancelled');
    assert.equal(ended.artifacts.length,0);
    const removed=ended.materials.find(file=>file.endedAt);
    assert.ok(removed);
    await request('/rooms/'+expiringRoom+'/materials/'+removed.id,undefined,410);
    assert.equal(model.calls.length,beforeExpired);
    await active.close();
    pass('重启时已到期的材料会清理，完整的旧推理结果也不能重新打开');

    const pendingData=join(scratch,'provider-open');
    active=await launchChild(pendingData);
    const earlier=model.calls.length;
    const pendingRoom=await create('brief');
    const pending=await start(pendingRoom,'慢速取消。等待模型响应。');
    await waitFor(async()=>{
      const current=(await room(pendingRoom)).runs.find(run=>run.id===pending.id);
      if (!['queued','running'].includes(current?.state)) throw new Error(current?.error??'未能启动断流夹具。');
      return model.calls.length;
    },value=>value>=earlier+1,55);
    active.kill();
    await active.exited;
    active=await launchChild(pendingData,'normal',true);
    const missing=await stage(pendingRoom,pending.id,'interrupted');
    assert.equal(missing.artifacts.length,0);
    assert.equal(model.calls.length,earlier+1);
    await active.close();
    pass('模型流还没完成时强制退出，原任务保留中断状态，恢复过程零重发');

    const stoppingData=join(scratch,'stopping');
    active=await launchChild(stoppingData,'stopping');
    const stoppingRoom=await create('media');
    const callsBeforeStop=model.calls.length;
    const stopping=await start(stoppingRoom,'慢速取消。测试等待确认停止时宿主退出。');
    await waitFor(()=>model.calls.length,value=>value>callsBeforeStop);
    const stopRequest=request('/runs/'+stopping.id+'/stop',{}).catch(()=>null);
    assert.equal((await awaitCrash(stoppingData)).state,'stopping');
    await stopRequest;
    const callsAfterStop=model.calls.length;
    active=await launchChild(stoppingData,'normal',true);
    const incomplete=await stage(stoppingRoom,stopping.id,'interrupted');
    assert.equal(incomplete.runs[0].stop.outcome,'unconfirmed');
    assert.equal(incomplete.artifacts.length,0);
    const stopEvents=await request('/runs/'+stopping.id+'/events');
    assert.equal(stopEvents.filter(row=>row.kind==='stop_settled').length,1);
    assert.equal(model.calls.length,callsAfterStop);
    await active.close();
    pass('等待执行器停止时宿主强制退出，重启后保留停止未确认，零重发且无成果写入');

    const invalidData=join(scratch,'mismatched');
    const invalid=await nativeScenario(invalidData);
    const base=join(invalidData,'runtime',invalid.run.id,'sessions');
    const [workspace]=await readdir(base);
    const file=join(base,workspace,invalid.witness.session,'session.v4.jsonl');
    const rows=(await readFile(file,'utf8')).trimEnd().split('\n').map(JSON.parse);
    rows.find(row=>row.type==='user/message'&&row.data.source.kind==='user').data.source.rpcId=randomUUID();
    await writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const beforeTamper=model.calls.length;
    active=await launchChild(invalidData,'normal',true);
    const denied=await stage(invalid.id,invalid.run.id,'interrupted');
    assert.match(denied.runs[0].error,/完成记录/);
    assert.equal(denied.artifacts.length,0);
    assert.equal(model.calls.length,beforeTamper);
    await active.close();
    pass('即使日志带完成状态，请求身份与原任务不一致也不会形成可写入预览');

    const racingData=join(scratch,'revision');
    const race=await nativeScenario(racingData);
    const workbench=new Workbench(await configFor({data:racingData,providerKey:''}));
    try {
      const context=await workbench.context(race.witness.project);
      await workbench.request('POST',workbench.path(race.witness.project,'/sources'),{
        revision:context.project.revision,label:'另一个编辑者的合成记录',nature:'simulation',origin:'recovery-fixture',
        content:'在 Hyper Bot 退出期间，原项目增加一份合成素材。'
      });
    } finally {
      await workbench.close();
    }
    const beforeRacing=model.calls.length;
    active=await launchChild(racingData,'normal',true);
    const conflict=await stage(race.id,race.run.id,'interrupted');
    assert.match(conflict.runs[0].error,/原项目发生变化/);
    assert.equal(conflict.artifacts.length,0);
    assert.equal(model.calls.length,beforeRacing);
    await active.close();
    pass('分镜找回时重新核对工作台修订，恢复期间发生项目变化会阻断本轮保存');

    const separateData=join(scratch,'independent');
    const originalState=join(scratch,'独立工作台');
    const originalProjects=join(originalState,'原项目');
    const env={SELF_MEDIA_STATE_DIR:originalState,SELF_MEDIA_DATA_DIR:originalProjects};
    const independent=await startFixtureWorkbench({appRoot:root,config:await configFor(),processEnvironment,
      state:originalState,projects:originalProjects});
    let linked;
    try {
      async function workbench(suffix,body) {
        const options=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
        const reply=await fetch(independent.registration.base_url+'/api'+suffix,{...options,signal:AbortSignal.timeout(6000)});
        const result=await reply.json();
        assert.ok(reply.ok,JSON.stringify(result));
        return result;
      }
      const project=await workbench('/projects',{title:'街角书店原项目',simulation:true});
      const stem='/agent/v1/projects/'+project.id;
      const [interview,notes]=makeSamples();
      const first=await workbench(stem+'/context');
      const {source}=await workbench(stem+'/sources',{
        revision:first.project.revision,nature:'simulation',origin:'独立工作台夹具',
        label:interview.name,content:interview.content
      });
      const initial=await workbench(stem+'/context');
      const selected=await nativeScenario(separateData,async()=>{
        const [choice]=await request('/projects/original');
        assert.equal(choice.id,project.id);
        const {id}=await request('/rooms',{botId:'media',revision:1,title:project.title,project:project.id,
          projectScope:'original',projectStorage:choice.storage,simulation:true},201);
        const existing=await request('/rooms/'+id+'/original/materials',{source:source.id,digest:source.sha256,authorized:true},201);
        const extra=await request('/rooms/'+id+'/materials',{name:notes.name,content:notes.content,authorized:true},201);
        await request('/rooms/'+id+'/draft',{text:'用这两份材料整理四镜口播分镜。',attachments:[existing.id,extra.id],base:null});
        return id;
      },env);
      const heldCalls=model.calls.length;
      active=await launchChild(separateData,'normal',true,env);
      const originalPreview=await stage(selected.id,selected.run.id,'waiting_approval');
      const job=originalPreview.runs[0];
      assert.equal(job.engineRecovered,true);
      assert.deepEqual(job.approval.sourceNames,[notes.name]);
      assert.equal((await workbench(stem+'/context')).context_id,initial.context_id);
      await request('/runs/'+job.id+'/decide',{id:job.approval.id,digest:job.approval.digest,allow:true},202);
      const saved=await stage(selected.id,selected.run.id,'succeeded');
      const written=await workbench(stem+'/context');
      assert.equal(written.sources.length,2);
      assert.equal(written.artifacts.length,1);
      assert.ok(written.sources.some(row=>row.id===source.id));
      assert.equal(written.heads.script,saved.artifacts[0].receipt.id);
      assert.equal(model.calls.length,heldCalls);
      linked={run:selected.run.id,project:project.id,artifact:written.heads.script};
      await active.close();
      pass('独立工作台的已有项目恢复原授权材料，确认前项目不变，确认后只写一份新增材料与一版分镜');
    } finally {
      independent.close();
    }

    const report={mode:'真实 DSH Web Host / Hermes ACP / Workbench，模型协议夹具及强制进程退出',checks,
      dsh:{run:script.run.id,engineSession:script.witness.session,project:script.witness.project,
        artifact:scriptDone.artifacts[0].receipt.id},hermes:{run:brief.id,artifact:briefDone.artifacts[0].id},independent:linked,
      providerCalls:model.calls.length,requestsDuringRecovery:0};
    if(process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally {
    await active?.close();
    for (const child of created) child.kill('SIGKILL');
    await model.close();
  }
}

