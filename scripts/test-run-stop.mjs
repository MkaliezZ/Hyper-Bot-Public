import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server/http.mjs')));
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const data=await mkdtemp(join(tmpdir(),'hb-stop-proof-'));
const model=await modelFixture({beforeResponse(prompt,response) {
  if (prompt.text.includes('慢速取消')) return new Promise(resolve=>response.once('close',resolve));
}});
const originalFetch=globalThis.fetch;
const checks=[], proofs={};
let host, browser, fault;
const pass=message=>{checks.push(message);console.log('OK '+message);};

function waitForAbort(signal) {
  signal.throwIfAborted();
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
}

globalThis.fetch=async(input,options)=>{
  const url=new URL(input);
  const bridge=options?.headers?.['X-Hyper-Bot-Bridge'];
  if (bridge && fault?.kind==='workbench-start' && url.pathname==='/api/status') {
    fault.entered=true;
    await fault.ready.promise;
  }
  if (bridge && fault?.kind==='workbench-list' && url.pathname==='/api/projects') {
    fault.entered=true;
    await waitForAbort(options.signal);
  }
  const privateHost=url.hostname==='127.0.0.1'&&options?.headers?.cookie;
  if (!fault || !privateHost) return originalFetch(input,options);
  if (url.pathname==='/api/session/cancel') {
    fault.requested=true;
    if (fault.kind==='offline') throw new TypeError('Private cancel transport interrupted by fixture');
    const response=await originalFetch(input,options);
    fault.ack=(await response.clone().json()).result?.value?.accepted===true;
    return response;
  }
  if (url.pathname!=='/api/session/events') return originalFetch(input,options);
  const response=await originalFetch(input,options);
  const body=await response.clone().json();
  const records=body.result?.value?.records??[];
  if (fault.kind==='wrong-request' && fault.requested && records.some(row=>row.event?.type==='turn/end')) {
    for (const row of records.filter(row=>row.event?.type==='user/message')) row.event.data.source.rpcId=fault.other;
    fault.changedIdentity=true;
    return Response.json(body,{status:response.status});
  }
  if (fault.kind==='late' && !fault.requested &&
      records.some(row=>row.event?.type==='turn/end'&&row.event.data.reason.kind==='completed')) {
    fault.finished=true;
    await waitForAbort(options.signal);
  }
  return response;
};

async function api(route,body,status) {
  const response=await originalFetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(20000),
    ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)})});
  const result=await response.json();
  if (status) assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}

async function until(read,ready=Boolean,ms=55000) {
  const signal=AbortSignal.timeout(ms);
  for (;;) {
    const result=await read();
    if (ready(result)) return result;
    await delay(135,null,{signal});
  }
}
const room=id=>api('/rooms/'+id);
const run=(id,job)=>room(id).then(view=>view.runs.find(item=>item.id===job.id));
const create=async (bot,title)=>(await api('/rooms',{botId:bot,revision:1,title,example:true},201)).id;
const send=(id,text,files)=>api('/rooms/'+id+'/runs',{
  text,attachments:files,clientRequestId:randomUUID(),authorized:true},202);
const stop=job=>api('/runs/'+job.id+'/stop',{},202);
const readEvents=job=>api('/runs/'+job.id+'/events');

async function slow(roomId,files) {
  const before=model.calls.length;
  const job=await send(roomId,'慢速取消。核对这两份已授权材料。',files);
  await until(()=>model.calls.length>before);
  return job;
}

async function assertStop(roomId,job,label,expected,started,timeout=16000) {
  const done=await until(()=>run(roomId,job),value=>!!value.finishedAt,timeout).catch(error=>{
    throw new Error(label+' did not settle in '+timeout+'ms',{cause:error});
  });
  assert.equal(done.state,expected.state,JSON.stringify(done.stop));
  assert.equal(done.stop.outcome,expected.outcome);
  assert.equal(done.stop.terminal,expected.terminal??null);
  assert.equal(done.stop.runtimeExited,expected.exited??null);
  assert.equal(done.approval?.status==='pending',false);
  assert.equal(done.recovery,null);
  assert.equal(done.artifact,undefined);
  const events=await readEvents(job);
  assert.deepEqual(events.map(row=>row.seq),events.map((_row,index)=>index+1));
  assert.equal(events.filter(row=>row.kind==='stop_settled').length,1);
  assert.equal(events.find(row=>row.kind==='stop_settled').data.outcome,expected.outcome);
  const elapsedMs=Math.round(performance.now()-started);
  assert.ok(elapsedMs<15000,label+' exceeded the observed stop window');
  proofs[label]={...done.stop,state:done.state,elapsedMs,run:job.id};
  return done;
}

const images=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const showUI=!process.argv.includes('--no-ui');
const settings={data,model:'deepseek-v4-flash',providerKey:'stop-fixture',upstream:model.origin};
try {
  host=await launch({options:settings});
  const media=await create('media','书店口播 · 停止演练');
  const draft=(await room(media)).draft;
  const noPrompt={state:'cancelled',outcome:'before_prompt'};
  for (const [kind,label] of [['workbench-start','workbenchStartup'],['workbench-list','beforePrompt']]) {
    fault={kind,entered:false,ready:Promise.withResolvers()};
    const early=await send(media,'启动模型前停止。',draft.attachments);
    await until(()=>fault.entered);
    const bridge=host.app.workbench.child;
    assert.ok(bridge?.pid);
    const before=performance.now();
    await stop(early);
    await assertStop(media,early,label,noPrompt,before,5000);
    const events=await readEvents(early);
    assert.equal(events.some(row=>['project_bound','workbench_intake','engine_started','provider_requested'].includes(row.kind)),false);
    fault.ready.resolve();
    fault=null;
    assert.deepEqual(await api('/projects'),[]);
    assert.equal(host.app.workbench.child,bridge);
    assert.equal(model.calls.length,0);
  }
  assert.equal((await room(media)).project,null);
  pass('工作台启动和读取项目列表期间可停止，保留各自回执，项目与模型请求均为零');

  const saved=await send(media,draft.text,draft.attachments);
  const pending=await until(()=>run(media,saved),value=>value.state==='waiting_approval');
  await api('/runs/'+saved.id+'/decide',{id:pending.approval.id,digest:pending.approval.digest,allow:true},202);
  const kept=await until(()=>run(media,saved),value=>value.state==='succeeded');
  const currentProject=(await room(media)).project;

  const confirmed=await slow(media,draft.attachments);
  let mark=performance.now();
  await stop(confirmed);
  await assertStop(media,confirmed,'webConfirmed',{state:'cancelled',outcome:'confirmed',terminal:'cancelled',exited:true},mark);
  pass('真实 DSH Web Host 的原请求返回用户取消终态后显示已停止');

  const otherRoom=await create('media','核对停止回执归属');
  const other=await slow(otherRoom,(await room(otherRoom)).draft.attachments);
  fault={kind:'wrong-request',other:randomUUID()};
  mark=performance.now();
  await stop(other);
  await assertStop(otherRoom,other,'wrongRequest',{state:'interrupted',outcome:'unconfirmed',exited:true},mark);
  assert.ok(fault.ack&&fault.changedIdentity);
  fault=null;
  pass('即使取消命令已受理，终态属于其他请求时仍显示停止未确认');

  const failed=await slow(media,draft.attachments);
  fault={kind:'offline'};
  mark=performance.now();
  let page, widget, visual;
  if (showUI) {
    const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
    page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(host.origin+'/#chat/'+media+'?run='+failed.id);
    widget=page.locator('#task-'+failed.id);
    mark=performance.now();
    await widget.getByRole('button',{name:'停止任务'}).click();
    await widget.getByText('正在等待执行器停止。',{exact:true}).waitFor();
    visual=[];
  } else await stop(failed);
  await assertStop(media,failed,'lostCancel',{state:'interrupted',outcome:'unconfirmed',exited:true},mark);
  assert.equal(fault.requested,true);
  fault=null;
  if (page) {
    const chip=widget.locator('.chip');
    await chip.getByText('停止未确认',{exact:true}).waitFor();
    await widget.getByRole('button',{name:'带回本轮草稿'}).waitFor();
    assert.ok(await widget.evaluate(node=>{
      const area=document.getElementById('message-feed').getBoundingClientRect(), row=node.getBoundingClientRect();
      return document.activeElement===node && row.top>=area.top && row.bottom<=area.bottom;
    }),'The mobile stop status and focused action must stay in view');
    for(const width of [1440,1024,768,390,320]) {
      await page.setViewportSize({width,height:width>=768?900:844});
      await page.emulateMedia({reducedMotion:width===320?'reduce':'no-preference'});
      const metric=await widget.evaluate(node=>{
        const line=node.querySelector('.reply-copy');
        return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,
          animation:getComputedStyle(line).animationDuration};
      });
      assert.ok(metric.overflow<=0,JSON.stringify(metric));
      assert.equal(metric.animation,width===320?'0s':'0.18s');
      visual.push(metric);
      if(images && [1440,390].includes(width)) {
        await widget.evaluate(node=>{
          const pane=document.getElementById('message-feed');
          const bounds=pane.getBoundingClientRect(), row=node.getBoundingClientRect();
          if (row.bottom>bounds.bottom-8) pane.scrollBy({top:row.bottom-bounds.bottom+9,behavior:'instant'});
        });
        await mkdir(images,{recursive:true});
        await page.screenshot({path:join(images,width===1440?'桌面-停止未确认.png':'手机-停止未确认.png'),animations:'disabled'});
      }
    }
  }
  pass('取消连接失联后回收子进程并记录中断，原任务提供带回草稿入口');

  fault={kind:'late'};
  const late=await send(media,'按同一书店素材再拟一份分镜。',draft.attachments);
  await until(()=>fault.finished);
  mark=performance.now();
  await stop(late);
  const lateRun=await assertStop(media,late,'lateCompletion',
    {state:'interrupted',outcome:'unconfirmed',terminal:'completed',exited:true},mark);
  fault=null;
  // Replay a delayed provider receipt against the already settled run.
  host.app.noteProvider(late.id,{...lateRun.usage,requestId:'late-stop-fixture',terminal:true},true);
  assert.equal((await run(media,late)).state,'interrupted');
  assert.ok((await readEvents(late)).some(row=>row.kind==='provider_completed_after_stop'));
  assert.deepEqual((await room(media)).artifacts.map(row=>row.id),[kept.artifact]);
  assert.equal((await host.app.workbench.context(currentProject)).artifacts.length,1);
  pass('迟到的真实执行器完成结果和提供方回执只入审计，原项目只有已批准的版本');

  const hermes=await create('brief','Hermes 简报停止');
  const hermesJob=await slow(hermes,(await room(hermes)).draft.attachments);
  mark=performance.now();
  await stop(hermesJob);
  await assertStop(hermes,hermesJob,'hermesConfirmed',{state:'cancelled',outcome:'confirmed',terminal:'cancelled',exited:true},mark);
  const hermesProfile=JSON.parse(await readFile(join(data,'runtime',hermesJob.id,'config.yaml'),'utf8'));
  assert.equal(hermesProfile.model_catalog.enabled,false);
  const candidate=await api('/bots',{id:'stop-proof-sdk',name:'SDK 取消核对',kind:'brief',driver:'dsh',
    description:'归纳两份原文并给出可核对的简报。',skills:['material-brief']},201);
  assert.equal((await api('/bots/stop-proof-sdk/'+candidate.revision+'/verify',{})).ok,true);
  await api('/bots/stop-proof-sdk/'+candidate.revision+'/publish',{});
  const sdk=await create('stop-proof-sdk','DSH SDK 简报停止');
  const sdkJob=await slow(sdk,(await room(sdk)).draft.attachments);
  mark=performance.now();
  await stop(sdkJob);
  await assertStop(sdk,sdkJob,'sdkIsolated',{state:'interrupted',outcome:'unconfirmed',exited:true},mark);
  pass('真实 Hermes ACP 逐轮确认停止，DSH SDK 的进程退出单独如实记为中断');

  const proposal=await send(media,'可供审批的分镜草稿。',draft.attachments);
  const ready=await until(()=>run(media,proposal),value=>value.state==='waiting_approval');
  mark=performance.now();
  await stop(proposal);
  await assertStop(media,proposal,'approvalRevoked',{state:'cancelled',outcome:'approval_revoked'},mark);
  assert.equal((await api('/runs/'+proposal.id+'/decide',{
    id:ready.approval.id,digest:ready.approval.digest,allow:true},409)).code,'approval_scope');
  const receipt=(await api('/receipts?category=simulation&days=all')).rows.find(row=>row.id===failed.id);
  assert.equal(receipt.stop.outcome,'unconfirmed');
  await host.close();host=null;
  host=await launch({options:settings});
  assert.equal((await run(media,failed)).stop.outcome,'unconfirmed');
  assert.deepEqual((await room(media)).artifacts.map(row=>row.id),[kept.artifact]);
  pass('撤销待批准写入后旧授权失效，重启仍可在原会话与运行回执核对停止结果');

  const result={version,fixture:true,checks,proofs,viewports:visual??[],priorArtifact:kept.artifact,modelRequests:model.calls.length};
  const out=process.env.HYPER_BOT_TEST_REPORT;
  if (out) await writeFile(out,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  fault?.ready?.resolve();
  fault=null;
  globalThis.fetch=originalFetch;
  await browser?.close();
  await host?.close();
  await model.close();
}
