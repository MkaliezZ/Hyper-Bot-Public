import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { modelFixture } from '../test/model-fixture.mjs';

const root=path.resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [hostApi,engines,config,contracts,registry,proxy]=await Promise.all(
  ['dsh-web-host','engines','config','contracts','registry','provider'].map(name=>
    import(pathToFileURL(path.join(root,'server',name+'.mjs')))));
const {openWebDsh,webSessionCall,sessionEvents}=hostApi;
const {execute,patchFor}=engines;
const fixture=await modelFixture();
const data=await mkdtemp(path.join(tmpdir(),'hb-dsh-controls-'));
const settings=await config.configFor({data,upstream:fixture.origin,providerKey:'synthetic-web-host-test'});
const materials=registry.makeSamples();
const prompt=requirement=>contracts.definitionPrompt({kind:'brief',skills:[{content:'按引用归纳分歧或缺项。'}],
  request:requirement,materials,conversationTitle:'书店合成测试'});
const limit=()=>AbortSignal.timeout(28000);
const checks=[];
function pass(text) {checks.push(text);console.log('OK '+text);}
async function until(action,signal) {
  for (;;) {
    signal.throwIfAborted();
    const result=await action();
    if(result)return result;
    await sleep(110,null,{signal});
  }
}
const open=(home,gateway,signal)=>openWebDsh(home,settings.model,patchFor(gateway.url,settings.model),signal);
const call=(host,method,request,signal)=>webSessionCall(host,'session/'+method,request,signal);
const sessionContents=events=>events.filter(event=>
  event.type==='user/message' && event.data?.source?.kind==='user');
const bytesFor=(method,request)=>JSON.stringify({
  type:'client-request',rpcId:randomUUID(),method,payload:{args:{request}}
});
const access=(host,method,owner,request)=>fetch(host.origin+'/api/'+method,{
  method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
  headers:{'content-type':'application/json',...(owner?{cookie:host.cookie}:{})},
  body:bytesFor(method,request)
}).then(response=>response.status);

async function controls(cancel) {
  const signal=limit(), gateway=await proxy.provider(settings,signal);
  const home=await mkdtemp(path.join(data,cancel?'cancel-':'history-'));
  const sessionId=randomUUID(), requestId=randomUUID();
  const before=performance.now();
  let host;
  try {
    host=await open(home,gateway,signal);
    const startupMs=Math.round(performance.now()-before);
    if (!cancel) {
      const request={address:{kind:'session',sessionId}};
      assert.equal(await access(host,'session/events',false,request),401);
      assert.equal(await access(host,'session/openWorkspacePath',true,{}),404);
      pass('Web Host 专用回环身份与受限方法');
    }
    const created=await call(host,'create',{sessionId,cwd:home},signal);
    assert.equal(created.sessionId,sessionId);
    const accepted=await call(host,'prompt',{sessionId,requestId,mode:'queue',
      content:[{type:'text',text:prompt(cancel?'慢速取消测试。':'归纳两份授权材料。')}]},signal);
    assert.equal(accepted.accepted,true);
    if(cancel) {
      await until(()=>gateway.usage.requests===1,signal);
      assert.equal((await call(host,'cancel',{sessionId},signal)).accepted,true);
    }
    const events=await until(async()=>{
      const history=await sessionEvents(host,sessionId,signal);
      return history.some(event=>event.type==='turn/end')?history:null;
    },signal);
    assert.deepEqual(sessionContents(events).map(event=>event.data.source.rpcId),[requestId]);
    const reason=events.find(event=>event.type==='turn/end').data.reason.kind;
    if(cancel) {
      assert.equal(reason,'aborted');
      assert.ok(!events.some(event=>event.type==='assistant/message'));
      pass('取消命中原 Session 并收到已中止终态');
      return {sessionId,requestId,startupMs,reason};
    }
    assert.equal(reason,'completed');
    assert.equal(gateway.usage.requests,1);
    assert.ok(events.some(event=>event.type==='assistant/message'));
    assert.deepEqual([gateway.usage.input,gateway.usage.output],[180,180]);
    await host.close();host=null;
    host=await open(home,gateway,signal);
    const opened=await sessionEvents(host,sessionId,signal);
    assert.deepEqual(sessionContents(opened).map(event=>event.data.source.rpcId),[requestId]);
    assert.ok(opened.some(event=>event.type==='assistant/message'));
    assert.equal(gateway.usage.requests,1);
    pass('相同 Session 跨 Host 重启冷读，期间没有新模型请求');
    return {sessionId,requestId,startupMs,reason,retainedEvents:opened.length};
  } finally {
    await host?.close();
    await gateway.close();
  }
}

try {
  const wall={sdk:[],'web-host':[]};
  const input=prompt('归纳两份授权材料。');
  for(const [id,name] of [['dsh','sdk'],['dsh-web','web-host'],['dsh-web','web-host'],['dsh','sdk']]) {
    const begun=performance.now();
    let usage;
    const answer=await execute(settings,id,randomUUID(),input,limit(),()=>{},value=>{usage=value;});
    contracts.resultOf('brief',answer,materials);
    assert.deepEqual([usage.input,usage.output,usage.requests],[180,180,1]);
    wall[name].push(Math.round(performance.now()-begun));
  }
  assert.ok(fixture.calls.every(call=>call.tools===0));
  pass('同一技能和模型夹具下两条 DSH 通道均完成两次，未提交工具定义');
  const history=await controls(false);
  const cancelled=await controls(true);
  assert.ok(fixture.calls.every(call=>call.tools===0));
  console.log(JSON.stringify({harness:config.DSH_VERSION,fixture:true,checks,history,cancelled,
    wallMs:wall,providerCalls:fixture.calls.length}));
} finally {
  await fixture.close();
}

