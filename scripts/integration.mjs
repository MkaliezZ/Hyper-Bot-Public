import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { modelFixture } from '../test/model-fixture.mjs';

const appRoot=resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{Workbench},{Problem}]=await Promise.all(['http','workbench','contracts']
  .map(name=>import(pathToFileURL(join(appRoot,'server',name+'.mjs')))));

const real=process.argv.includes('--real');
const policyCases=[
  {botId:'media',driver:'dsh-web',protocol:'messages',prompt:'验证口播文字响应。',
    event:{type:'content_block_start',content_block:{type:'tool_use',name:'unsupported_fixture'}}},
  {botId:'brief',driver:'hermes',protocol:'chat-completions',prompt:'验证简报文字响应。',
    event:{choices:[{delta:{tool_calls:[{id:'unsupported_fixture'}]}}]}}
];
const model=real?null:await modelFixture({
  beforeResponse(prompt,response) {
    const denied=policyCases.find(item=>prompt.text.includes(item.prompt));
    if(denied&&!response.destroyed) {
      const closed=new Promise(resolve=>response.once('close',resolve));
      response.writeHead(200,{'Content-Type':'text/event-stream','X-Request-Id':'local-policy-check'});
      response.end('data: '+JSON.stringify(denied.event)+'\n\n');
      return closed;
    }
    if(prompt.text.includes('慢速取消')&&!response.destroyed) {
      return new Promise(resolve=>response.once('close',resolve));
    }
  }
});
const data=await mkdtemp(join(tmpdir(),'hyper-bot-integration-'));
let failAfterWrite=false,host;
class TestWorkbench extends Workbench {
  async request(method,route,body,signal) {
    const output=await super.request(method,route,body,signal);
    if (failAfterWrite&&method==='POST'&&route.endsWith('/artifacts')) {
      failAfterWrite=false;
      throw new Problem(503,'联调注入的提交后断线。','workbench_transport');
    }
    return output;
  }
}
const options={data,...(real?{}:{providerKey:'hyper-bot-test',upstream:model.origin})};
const open=()=>launch({options,workbenchFactory:c=>new TestWorkbench(c)});
const checks=[];
function pass(value){checks.push(value);console.log('OK '+value);}
async function api(route,body,expected) {
  const response=await fetch(host.origin+'/api'+route,body===undefined?{}:{
    method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)});
  const result=await response.json();
  if(expected)assert.equal(response.status,expected,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}
const room = id=>api('/rooms/'+id);
async function stage(roomId,runId,desired,observed=()=>true) {
  const until=Date.now()+95000;
  while(Date.now()<until) {
    const current=await room(roomId);
    const run=current.runs.find(r=>r.id===runId);
    if(run?.state===desired&&observed(run))return {current,run};
    if(run && ['failed','interrupted','cancelled','succeeded'].includes(run.state)) {
      throw new Error('Expected '+desired+' but received '+run.state+': '+run.error);
    }
    await sleep(280);
  }
  throw new Error('Timed out waiting for '+desired);
}
const approve = (run,allow=true,status)=>api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow},status);
const start = (id,text,attachments,base=null,clientRequestId=randomUUID())=>api('/rooms/'+id+'/runs',{text,attachments,base,clientRequestId,authorized:true});
const create = async (botId,rev,title='书店开门前')=>(await api('/rooms',{botId,revision:rev,title,example:true})).id;
const receipt=(state,version)=>state.artifacts.find(record=>record.version===version)?.receipt;

try {
  host=await open();
  const workspace=await api('/workspace');
  assert.ok(workspace.bots.every(bot=>!bot.blocked),JSON.stringify(workspace.bots.map(b=>b.blocked)));
  const media=await create('media',1);
  const firstView=await room(media);
  const files=firstView.draft.attachments;
  const requestId=randomUUID();
  const first=await start(media,firstView.draft.text,files,null,requestId);
  const duplicate=await start(media,firstView.draft.text,files,null,requestId);
  assert.equal(first.id,duplicate.id);
  const pending=await stage(media,first.id,'waiting_approval');
  assert.equal(pending.current.artifacts.length,0);
  const forbidden=await api('/runs/'+pending.run.id+'/decide',{id:randomUUID(),digest:pending.run.approval.digest,allow:true},409);
  assert.equal(forbidden.code,'approval_scope');
  assert.equal(await approve(pending.run,true,202).then(v=>v.decision),'accepted');
  await approve(pending.run,true,409);
  const v1=await stage(media,first.id,'succeeded');
  const wb1=receipt(v1.current,1);
  assert.ok(wb1.id&&wb1.project);
  pass('DSH → 原项目首稿，重复发送和审批只产生一份结果');
  const next=await start(media,'这次只改开场，以「今天，从店主摆好第一排书开始。」为第一镜口播，保留其余分镜。',files,v1.current.artifacts[0].id);
  const revision=await stage(media,next.id,'waiting_approval');
  await approve(revision.run);
  const v2=await stage(media,next.id,'succeeded');
  const wb2=receipt(v2.current,2);
  assert.equal(wb1.project,wb2.project);
  assert.equal(wb2.supersedes,wb1.id);
  const context=await host.app.workbench.context(wb1.project);
  assert.equal(context.heads.script,wb2.id);
  assert.ok(context.artifacts.some(a=>a.id===wb1.id));
  const md=await api('/artifacts/'+v2.current.artifacts[1].id+'/export');
  assert.ok(md.markdown.includes(wb2.id));
  assert.equal(md.manifest.previous,v1.current.artifacts[0].id);
  const events=await api('/runs/'+next.id+'/events');
  assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));
  assert.ok(events[0].data.role==='user' && events.some(e=>e.kind==='approval'));
  pass('同一项目改稿和导出，可回读首稿、改稿、引用和顺序事件');

  if(!real) {
    const third=await start(media,'在相同项目继续修改。',files,v2.current.artifacts[1].id);
    const proposal=await stage(media,third.id,'waiting_approval');
    failAfterWrite=true;
    await approve(proposal.run);
    const uncertain=await stage(media,third.id,'interrupted');
    assert.equal(uncertain.run.recovery,'required');
    assert.equal(uncertain.current.artifacts.length,2);
    const blocked=await api('/rooms/'+media+'/runs',{text:'重复写入',attachments:files,base:null,clientRequestId:randomUUID(),authorized:true},409);
    assert.equal(blocked.code,'recovery_required');
    await host.close();host=await open();
    const recovered=await api('/runs/'+third.id+'/recover',{});
    assert.equal(recovered.found,true);
    assert.equal((await room(media)).artifacts.length,3);
    await api('/runs/'+third.id+'/recover',{},409);
    pass('实际 Workbench 写入后断线，重启后通过只读核对找回同一版本');
    const fourth=await start(media,'再改开场准备确认。',files);
    const denied=await stage(media,fourth.id,'waiting_approval');
    await approve(denied.run,false);
    await stage(media,fourth.id,'cancelled');
    const fifth=await start(media,'模拟项目同时编辑的冲突。',files);
    const concurrent=await stage(media,fifth.id,'waiting_approval');
    const fresh=await host.app.workbench.context(wb1.project);
    await host.app.workbench.request('POST',host.app.workbench.path(wb1.project,'/sources'),
      {revision:fresh.project.revision,label:'并发记录',nature:'simulation',origin:'hyper-bot-test',content:'另一位编辑员添加了拍摄说明。'});
    await approve(concurrent.run);
    const collision=await stage(media,fifth.id,'failed');
    assert.match(collision.run.error,/变化/);
    assert.equal(collision.current.artifacts.length,3);
    assert.equal(collision.run.approval.status,'revoked');
    const invalidated={id:concurrent.run.approval.id,digest:concurrent.run.approval.digest};
    await api('/runs/'+fifth.id+'/revise',{...invalidated,draftToken:collision.current.draftToken},202);
    const preserved=await room(media);
    assert.deepEqual(preserved.draftProposal.result,concurrent.run.preview);
    assert.deepEqual(preserved.draftProposal.timing,concurrent.run.previewTiming);
    assert.equal(preserved.draft.retryOf,fifth.id);
    assert.equal((await host.app.workbench.context(wb1.project)).heads.script,preserved.artifacts.at(-1).receipt.id);
    const resumed=await api('/rooms/'+media+'/runs',{...preserved.draft,text:'依据带回的分镜重新核对开场。',
      clientRequestId:randomUUID(),authorized:true},202);
    const freshApproval=await stage(media,resumed.id,'waiting_approval');
    assert.equal(freshApproval.run.proposalBase,fifth.id);
    assert.equal(freshApproval.run.approval.project,concurrent.run.approval.project);
    assert.ok(freshApproval.run.approval.revision>concurrent.run.approval.revision);
    await api('/runs/'+resumed.id+'/decide',{...invalidated,allow:true},409);
    await approve(freshApproval.run,false,202);
    await stage(media,resumed.id,'cancelled');
    const callsBeforeStop=model.calls.length;
    const running=await start(media,'慢速取消测试。',files);
    await stage(media,running.id,'running',run=>run.engineSession&&model.calls.length>callsBeforeStop);
    await api('/runs/'+running.id+'/stop',{});
    const stopped=await stage(media,running.id,'cancelled');
    assert.equal(stopped.run.stop.outcome,'confirmed');
    assert.equal(stopped.run.stop.terminal,'cancelled');
    pass('原项目冲突只带回待审稿，重新生成后校验新修订，新旧批准互不代用，拒绝与停止保留已有版本');

    const expiring=await start(media,'核对审批有效期。',files);
    const expired=await stage(media,expiring.id,'waiting_approval');
    host.store.change(state=>{state.runs.find(run=>run.id===expiring.id).approval.expiresAt=Date.now()-1;});
    host.app.expire();
    await approve(expired.run,true,409);
    const lapsed=await stage(media,expiring.id,'interrupted');
    const callsBeforeRestore=model.calls.length;
    await api('/runs/'+expiring.id+'/revise',{id:expired.run.approval.id,digest:expired.run.approval.digest,
      draftToken:lapsed.current.draftToken},202);
    assert.deepEqual((await room(media)).draftProposal.result,expired.run.preview);
    assert.equal(model.calls.length,callsBeforeRestore);

    const continuing=await start(media,'核对重开后原审批是否失效。',files);
    const oldApproval=await stage(media,continuing.id,'waiting_approval');
    await host.close();host=await open();
    await stage(media,continuing.id,'interrupted');
    await approve(oldApproval.run,true,409);
    assert.equal((await room(media)).artifacts.length,3);
    pass('过期后可带回同一待审稿，原批准和上一进程的批准均不能写入');

    const wrongRoom=await create('media',1,'另一个授权范围');
    await api('/rooms/'+wrongRoom+'/materials/'+files[0],undefined,403);
    await api('/rooms/'+wrongRoom+'/materials',{name:'测试.py',content:'合成测试',authorized:true},422);
    await api('/rooms/'+wrongRoom+'/materials',{name:'测试.md',content:'合成测试',authorized:false},422);
    pass('跨会话读取、未授权文字和错误文件格式均被拒绝');
  }

  const brief=await create('brief',1,'书店素材核对');
  const briefDraft=(await room(brief)).draft;
  const briefRun=await start(brief,briefDraft.text,briefDraft.attachments);
  const briefDone=await stage(brief,briefRun.id,'succeeded');
  assert.ok(briefDone.current.artifacts[0].result.points[0].evidence.length);
  pass('Hermes ACP → 实际归纳引用并写入本机会话成果库');

  if(!real) {
    const accepted=await api('/skills',{slug:'evidence-index',version:'1.0.0',name:'归纳原文',
      origin:'Hyper Bot 合成测试',reviewed:true,content:'# 方法\n逐条摘录能够回到输入的原文，并解释这条摘录支持的观点。',
      references:[]});
    assert.equal(accepted.id,'evidence-index@1.0.0');
    await api('/skills',{slug:'outside-ref',version:'1.0.0',name:'无效引用',origin:'合成测试',reviewed:true,
      content:'# 方法\n本段引用一个未提供的文本 [更多](../outside.md)。',references:[]},422);
    pass('文本 Skill 导入记录摘要，包外引用无法登记');
  }
  const candidate=await api('/bots',{id:'brief-dsh',name:'素材简报（DSH）',kind:'brief',driver:'dsh',
    description:'接入验证，用同一个 Skill 整理书店合成素材。',skills:['material-brief']});
  await api('/bots/brief-dsh/'+candidate.revision+'/publish',{},409);
  const sample=await api('/bots/brief-dsh/'+candidate.revision+'/verify',{});
  assert.ok(sample.ok,JSON.stringify(sample));
  const harness=(await api('/workspace')).drivers.find(driver=>driver.id===candidate.driver);
  assert.equal(candidate.driverRevision,harness.revision);
  assert.equal(sample.driverRevision,harness.revision);
  assert.ok(briefDone.run.driverRevision);
  const enabled=await api('/bots/brief-dsh/'+candidate.revision+'/publish',{});
  assert.equal(enabled.status,'enabled');
  assert.equal(enabled.driverRevision,harness.revision);
  await api('/bots/brief/1/disable',{});
  assert.equal((await room(brief)).artifacts.length,1);
  await api('/rooms/'+brief+'/runs',{text:briefDraft.text,attachments:briefDraft.attachments,clientRequestId:randomUUID(),authorized:true},409);
  await api('/bots/brief/1/restore',{});
  assert.equal((await room(brief)).artifacts.length,1);
  pass('同一简报 Skill 在 DSH 上通过验证，候选、验收与启用绑定同一 Harness 版本，停用及恢复保留历史');

  const blockedModelResponses=[];
  if (!real) {
    const attempts=model.calls.length;
    for(const item of policyCases) {
      const id=await create(item.botId,1,item.prompt);
      const {draft}=await room(id);
      const job=await start(id,item.prompt,draft.attachments);
      const {current,run}=await stage(id,job.id,'failed');
      assert.match(run.error,/禁用的工具动作/);
      assert.equal(run.approval,null);
      assert.equal(current.artifacts.length,0);
      assert.equal(run.driver,item.driver);
      assert.equal(run.usage.protocol,item.protocol);
      assert.equal(run.usage.requests,1);
      assert.equal(run.usage.terminal,false);
      if(item.botId==='media')assert.equal((await host.app.workbench.context(run.project)).artifacts.length,0);
      blockedModelResponses.push({driver:run.driver,protocol:run.usage.protocol,state:run.state,approvals:0,artifacts:0});
    }
    assert.equal(model.calls.length-attempts,policyCases.length);
    pass('DSH Web Host 与 Hermes ACP 均拦截禁用的模型工具响应，保留失败原因和一次请求回执');

    const updated=await api('/bots',{id:'brief',name:'素材简报',kind:'brief',driver:'dsh-web',
      description:'在新版继续归纳已授权的文字材料。',skills:['material-brief'],sourceRevision:1},201);
    const revision='/bots/brief/'+updated.revision;
    assert.equal((await api(revision+'/verify',{})).ok,true);
    await api(revision+'/publish',{});
    const body={botId:'brief',revision:updated.revision,title:'跨版本简报',
      handoff:{from:brief,materials:briefDraft.attachments,requestId:randomUUID(),authorized:true}};
    const {id:continued}=await api('/rooms',body,201);
    assert.equal((await api('/rooms',body,201)).id,continued);
    const carried=await room(continued);
    assert.deepEqual(carried.draft.attachments,briefDraft.attachments);
    assert.deepEqual(carried.continuedFrom,{id:brief,revision:1});
    const sent=await start(continued,briefDraft.text,carried.draft.attachments);
    const report=await stage(continued,sent.id,'succeeded');
    assert.equal(report.run.driver,'dsh-web');
    assert.equal(report.current.artifacts.length,1);
    const withdrawn=briefDraft.attachments[0];
    await api('/rooms/'+brief+'/materials/'+withdrawn+'/revoke',{confirmed:true},202);
    assert.equal((await api('/rooms/'+continued+'/materials/'+withdrawn,undefined,410)).code,'material_ended');
    assert.equal((await api('/artifacts/'+report.current.artifacts[0].id+'/export',undefined,410)).code,'material_ended');
    pass('Bot 版本续接只使用经选择的历史材料，撤回同步关闭新版的原文和成果');
  }
  assert.ok(real || model.calls.every(call=>call.tools===0&&call.materialCount>=2));
  const report={mode:real?'实际 DeepSeek 推理':'本机协议夹具',data,checks,
    first:{run:first.id,artifact:wb1.id,project:wb1.project,usage:v1.run.usage},
    revision:{run:next.id,artifact:wb2.id,usage:v2.run.usage},
    hermes:{run:briefRun.id,usage:briefDone.run.usage},additional:sample,
    providerCalls:model?.calls.length ?? 4,...(real?{}:{blockedModelResponses})};
  await writeFile(join(data,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  await host?.close();
  await model?.close();
}

