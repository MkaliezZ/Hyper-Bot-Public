import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(path.join(root,'server/http.mjs')));
const childProcess=createRequire(import.meta.url)('node:child_process');
const originalFork=childProcess.fork, originalFetch=globalThis.fetch, originalTimeout=AbortSignal.timeout;
const fixture=await modelFixture();
const data=await mkdtemp(path.join(tmpdir(),'hb-dsh-retry-'));
const bot='dsh-start-retry';
let host, probe;
const report={};

function scenario(mode) {
  probe={mode,children:[],connects:0,prompts:0,scheduled:0};
  return probe;
}

function exited(child) {return child.exitCode!==null || child.signalCode!==null;}

childProcess.fork=(file,args,options)=>{
  if (!probe || path.basename(file)!=='dsh-web-worker.mjs') return originalFork(file,args,options);
  assert.ok(probe.children.every(exited),'The previous private Web Host must exit before replacement');
  const child=originalFork(file,args,options);
  probe.children.push(child);
  if (probe.mode==='startup' && probe.children.length===1) {
    const emit=child.emit;
    child.emit=function(event,...params){
      if (event==='message') return false; // Withhold only the first worker's ready message.
      return emit.call(this,event,...params);
    };
  }
  return child;
};
syncBuiltinESMExports();
AbortSignal.timeout=milliseconds=>{
  if (probe?.mode==='startup' && milliseconds===24000 && probe.scheduled++===0) return originalTimeout(200);
  return originalTimeout(milliseconds);
};
globalThis.fetch=async (input,options)=>{
  const target=new URL(input);
  if (probe && target.hostname==='127.0.0.1') {
    if (target.pathname==='/connect' && target.searchParams.has('token')) {
      probe.connects++;
      if (probe.mode==='connect-twice' || (probe.mode==='connect' && probe.connects===1)) {
        await delay(60000,null,{signal:options.signal}).catch(()=>{throw options.signal.reason;});
      }
      if (probe.mode==='identity-denied') return new Response(null,{status:403});
      if (probe.mode==='cancel') {
        const stop=await originalFetch(host.origin+'/api/runs/'+probe.run+'/stop',{
          method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:'{}'
        });
        assert.equal(stop.status,202);
        options.signal.throwIfAborted();
      }
    }
    if (target.pathname==='/api/session/prompt') {
      probe.prompts++;
      if (probe.mode==='lost-ack') {
        const accepted=await originalFetch(input,options);
        assert.equal(accepted.status,200);
        const envelope=await accepted.json();
        assert.equal(envelope.result?.ok,true);
        assert.equal(envelope.result.value?.accepted,true);
        throw new Error('Fixture discarded the response to an accepted prompt');
      }
    }
  }
  return originalFetch(input,options);
};

async function api(route,body,status=200) {
  const response=await originalFetch(host.origin+'/api'+route,{signal:originalTimeout(75000),
    ...(body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  assert.equal(response.status,status,JSON.stringify(result));
  return result;
}

async function makeRoom(title) {
  const {id}=await api('/rooms',{botId:bot,revision:1,title,example:true},201);
  return {id,route:'/rooms/'+id,attachments:(await api('/rooms/'+id)).draft.attachments};
}

function events(id) {
  return host.store.events.all(id,0).map(row=>({kind:row.kind,data:JSON.parse(row.data)}));
}

function expectedRetry(runId,phase,conversationId) {
  return {runId,...(conversationId?{conversationId}:{}),botId:bot,botRevision:1,role:'system',phase,reason:'timeout',attempt:2};
}

async function complete(room,id) {
  const deadline=originalTimeout(65000);
  for(;;){
    const state=await api(room.route);
    const run=state.runs.find(row=>row.id===id);
    if(run?.finishedAt && probe.children.every(exited)) return {run,artifacts:state.artifacts};
    await delay(100,null,{signal:deadline});
  }
}

async function send(room) {
  return (await api(room.route+'/runs',{text:'按两份原文整理简报。',attachments:room.attachments,
    clientRequestId:randomUUID(),authorized:true},202)).id;
}

try {
  host=await launch({options:{data,upstream:fixture.origin,providerKey:'fixture'}});
  await api('/bots',{id:bot,name:'材料核对演练',kind:'brief',driver:'dsh-web',skills:['material-brief'],
    description:'按两份授权文字整理材料。'},201);
  const start=scenario('startup');
  const verification=await api('/bots/'+bot+'/1/verify',{});
  assert.equal(verification.ok,true,verification.reason);
  assert.equal(start.children.length,2);
  assert.equal(start.prompts,1);
  assert.equal(verification.usage.requests,1);
  assert.deepEqual(events(verification.runId).filter(row=>row.kind==='runtime_start_retry').map(row=>row.data),
    [expectedRetry(verification.runId,'startup')]);
  report.startup={workers:start.children.length,requests:verification.usage.requests,retryAudited:true};
  console.log('OK 首个进程就绪超时，确认退出后验证样例成功，模型协议请求一次');

  await api('/bots/'+bot+'/1/publish',{});
  for (const [mode,state,workers,prompts,retry] of [
    ['connect','succeeded',2,1,true],['connect-twice','failed',2,0,true],
    ['cancel','cancelled',1,0,false],['identity-denied','failed',1,0,false],['lost-ack','failed',1,1,false]
  ]) {
    const room=await makeRoom('隔离运行 '+mode);
    const current=scenario(mode);
    const before=fixture.calls.length;
    const id=await send(room);
    current.run=id;
    const result=await complete(room,id);
    assert.equal(result.run.state,state,JSON.stringify({error:result.run.error,stop:result.run.stop}));
    assert.equal(current.children.length,workers);
    assert.equal(current.prompts,prompts);
    assert.equal(result.artifacts.length,mode==='connect'?1:0);
    assert.deepEqual(events(id).filter(row=>row.kind==='runtime_start_retry').map(row=>row.data),
      retry?[expectedRetry(id,'connect',room.id)]:[]);
    if (mode==='cancel') assert.equal(result.run.stop.outcome,'before_prompt');
    const requests=fixture.calls.length-before;
    if (mode==='lost-ack') assert.ok(requests<=1);
    else assert.equal(requests,prompts);
    report[mode]={workers,prompts,requests,state,retryAudited:retry};
    console.log('OK '+mode+' '+state+' · '+workers+' 个 Host · '+prompts+' 次任务提交');
  }
  console.log(JSON.stringify(report));
} finally {
  probe=null;
  childProcess.fork=originalFork;
  syncBuiltinESMExports();
  globalThis.fetch=originalFetch;
  AbortSignal.timeout=originalTimeout;
  await host?.close();
  await fixture.close();
}
