import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{Workbench},{Problem}]=await Promise.all(['http','workbench','contracts']
  .map(name=>import(pathToFileURL(join(root,'server',name+'.mjs')))));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const model=await modelFixture();
const data=await mkdtemp(join(tmpdir(),'hb-task-links-'));
const options={data,upstream:model.origin,providerKey:'fixture'};
const counters={attempts:0,writes:0,reads:0};
let disconnect,host,browser;
const checks=[];
const pass=message=>{checks.push(message);console.log('OK '+message);};
const engine={harness:'DSH Web Host',model:'HTTP fixture',workbench:'isolated installed Self Media Workbench'};

class TestWorkbench extends Workbench {
  async request(method,route,body,signal) {
    if(method!=='POST'||!route.endsWith('/artifacts'))return super.request(method,route,body,signal);
    counters.attempts++;
    const point=disconnect;
    disconnect=null;
    if(point==='before')throw new Problem(503,'测试连接在保存前断开。','workbench_transport');
    const result=await super.request(method,route,body,signal);
    counters.writes++;
    if(point==='after')throw new Problem(503,'测试连接在保存后断开。','workbench_transport');
    return result;
  }
  async recover(plan,signal) {
    counters.reads++;
    return super.recover(plan,signal);
  }
}
const open=port=>launch({port,options,workbenchFactory:config=>new TestWorkbench(config)});

async function api(route,body,status) {
  const method=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...method,signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}
const room=id=>api('/rooms/'+id);
const openRoom=(botId,title,extra={})=>api('/rooms',{botId,revision:1,title,example:true,...extra},201).then(row=>row.id);
const runs=id=>'/rooms/'+id+'/runs';
const receipt=id=>'/runs/'+id+'/recover';
const choice=(run,allow)=>({id:run.approval.id,digest:run.approval.digest,allow});
const approve=(run,allow)=>api('/runs/'+run.id+'/decide',choice(run,allow),202);
const target=run=>'#chat/'+run.conversation+'?run='+run.id;

async function start(id,text='按两份材料整理成分镜。',attachments=null,status=202,base=null) {
  const draft=(await room(id)).draft;
  return api(runs(id),{text,attachments:attachments??draft.attachments,base,clientRequestId:randomUUID(),authorized:true},status);
}

async function waitFor(id,expected) {
  const limit=AbortSignal.timeout(55000);
  for(;;){
    const run=(await room(id.conversation)).runs.find(row=>row.id===id.id);
    if(run?.state===expected)return run;
    if(['failed','interrupted','cancelled','succeeded'].includes(run?.state))throw new Error(run.state+' '+run.error);
    await delay(170,null,{signal:limit});
  }
}
const recordings=process.env.HYPER_BOT_TEST_SCREENSHOTS;
async function shot(page,name) {
  if(!recordings)return;
  await mkdir(recordings,{recursive:true});
  await page.screenshot({path:join(recordings,name+'.png'),animations:'disabled'});
}
async function fits(page,width,selector) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
  const rect=await page.locator(selector).boundingBox();
  assert.ok(rect?.x>=0&&rect.x+rect.width<=width,JSON.stringify(rect));
}

try {
  host=await open(0);
  const script=await openRoom('media','街角书店开门前');
  const other=await openRoom('brief','书店采访简报');
  const prior=await waitFor(await start(script),'waiting_approval');
  await approve(prior,false);
  await waitFor(prior,'cancelled');
  const pending=await waitFor(await start(script,'根据原笔记做一版书店开门的分镜。',prior.materialIds),'waiting_approval');
  assert.equal((await api('/runs/'+prior.id+'/decide',choice(pending,true),409)).code,'approval_scope');
  assert.equal(counters.attempts,0);
  assert.deepEqual(pending.approval.review,{version:1,sourceVersion:null,headVersion:null,changes:null});
  assert.deepEqual((await api('/recoveries')).rows,[]);
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  for(const [width,height] of [[1440,900],[390,844],[320,780]]) {
    await page.setViewportSize({width,height});
    await page.goto(host.origin+'/#chat/'+other);
    await page.getByRole('heading',{name:'书店采访简报',exact:true}).waitFor();
    if(width===390) {
      await page.getByRole('link',{name:'查看写入审批 · 街角书店开门前'}).waitFor();
      await shot(page,'手机-跨会话审批入口');
      await page.getByRole('button',{name:'预览',exact:true}).click();
      await page.locator('#right-preview').waitFor({state:'visible'});
    }
    const link=page.getByRole('link',{name:'查看写入审批 · 街角书店开门前'});
    await link.waitFor();
    await fits(page,width,'.chat-run-bar');
    assert.equal(await link.getAttribute('href'),target(pending));
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(url=>url.hash===target(pending));
    await page.waitForFunction(run=>document.activeElement?.closest('.task-anchor')?.id==='task-'+run,pending.id);
    const card=page.getByRole('region',{name:'本轮写入审批'});
    assert.match(await card.innerText(),new RegExp(pending.id.slice(0,8)));
    const visible=await card.evaluate(el=>el.getBoundingClientRect().top>=
      el.closest('.thread-scroll').getBoundingClientRect().top-1);
    assert.ok(visible);
  }
  pass('跨 Bot 的审批入口在桌面和手机可用，预览打开时仍可操作，键盘直达绑定的本轮审批');
  disconnect='after';
  await page.getByRole('button',{name:'允许本次写入',exact:true}).click();
  assert.equal((await waitFor(pending,'interrupted')).recovery,'required');
  assert.deepEqual(counters,{attempts:1,writes:1,reads:0});
  const {project}=await room(script);
  const sibling=await openRoom('media','同一原项目的其他会话',{project,simulation:true});
  assert.equal((await start(sibling,'尝试从另一会话重复保存。',null,409)).code,'recovery_required');
  const port=Number(new URL(host.origin).port);
  await host.close();
  host=await open(port);
  assert.equal((await api('/workspace')).pendingWriteChecks,1);
  const waiting=(await api('/recoveries')).rows[0];
  assert.equal(waiting.id,pending.id);
  assert.equal(waiting.state,'pending');
  const unresolved=(await api('/receipts?category=simulation')).rows.find(row=>row.id===pending.id);
  assert.equal(unresolved.recoveryPending,true);
  assert.equal(unresolved.delivered,false);
  assert.ok(waiting.files.length);
  assert.doesNotMatch(JSON.stringify(waiting),/approval|digest|preview|prompt|content/);
  assert.equal(counters.reads,0);
  pass('已保存后断开从重启后的核对列表找回，浏览列表不查询工作台，同项目其他会话也不能重复派活');

  await page.setViewportSize({width:1440,height:900});
  await page.goto(host.origin+'/#chat/'+other);
  await page.getByRole('link',{name:/断线核对.*1 项待核对/}).click();
  await page.getByRole('heading',{name:'核对这版稿件是否已保存'}).waitFor();
  const ownership=page.getByRole('region',{name:'任务归属'});
  assert.match(await ownership.innerText(),/自媒体口播/);
  assert.match(await ownership.innerText(),new RegExp(pending.id.slice(0,8)));
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:width<=390?844:900});
    await fits(page,width,'.recovery-grid');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  const panel=page.locator('.receipt-status .status-in');
  assert.equal(await panel.evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1440,height:900});
  await page.locator('.connection-banner').waitFor({state:'hidden'});
  await shot(page,'桌面-断线核对');
  const before=model.calls.length;
  await page.getByRole('button',{name:'只读核对原项目',exact:true}).click();
  const draft=page.getByRole('link',{name:'打开稿件 v1',exact:true});
  await draft.waitFor();
  const saved=(await api('/recoveries')).rows[0];
  assert.equal(saved.state,'saved');
  assert.equal(saved.id,pending.id);
  assert.equal(await draft.getAttribute('href'),'#chat/'+script+'?artifact='+saved.artifact.id);
  assert.equal((await room(script)).artifacts.length,1);
  const counted=(await api('/receipts?category=simulation')).rows.find(row=>row.id===pending.id);
  assert.equal(counted.reconciled,true);
  assert.equal(counted.delivered,true);
  assert.equal(counted.usage.requests,1);
  await draft.click();
  await page.getByText('书店开门前的 45 秒',{exact:true}).first().waitFor();
  await api(receipt(pending.id),{},409);
  assert.deepEqual(counters,{attempts:1,writes:1,reads:1});
  assert.equal(model.calls.length,before);
  pass('只读找回同一稿件并按原会话打开，对照五种视口和减少动效，始终只有一次原项目写入');

  const uncertain=await openRoom('media','雨后书店橱窗');
  const missing=await waitFor(await start(uncertain),'waiting_approval');
  disconnect='before';
  await approve(missing,true);
  await waitFor(missing,'interrupted');
  await page.goto(host.origin+'/#recovery/'+missing.id);
  await page.getByRole('button',{name:'只读核对原项目',exact:true}).click();
  await page.getByText('未读到匹配回执。原项目的写入仍待核对。',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('未读到匹配回执。原项目的写入仍待核对。',{exact:true}).waitFor();
  assert.equal((await api('/recoveries')).rows[0].state,'pending');
  assert.equal((await api('/workspace')).pendingWriteChecks,1);
  assert.equal((await room(uncertain)).artifacts.length,0);
  assert.equal(counters.writes,1);
  assert.equal(counters.attempts,2);
  assert.equal((await start(uncertain,'再次发送。',missing.materialIds,409)).code,'recovery_required');
  pass('缺匹配回执时待核对跨刷新保留，未生成任何稿件，当前项目仍阻止重提');

  await api('/rooms/'+uncertain+'/materials/'+missing.materialIds[0]+'/revoke',{confirmed:true},202);
  const remaining=(await api('/recoveries')).rows;
  assert.equal(remaining.some(row=>row.id===missing.id),false);
  assert.equal((await api('/workspace')).pendingWriteChecks,0);
  await api(receipt(missing.id),{},409);
  assert.deepEqual(errors,[]);
  pass('材料撤回立即移除核对材料与任务入口，浏览器无运行错误');

  const cleanupLimit=AbortSignal.timeout(20000);
  while(host.store.read().materials.find(file=>file.id===missing.materialIds[0])?.cleanup!=='complete') {
    await delay(100,null,{signal:cleanupLimit});
  }
  const first=(await room(script)).artifacts[0];
  const next=await waitFor(await start(script,'用原材料再写一版。',first.materialIds),'waiting_approval');
  await approve(next,true);
  await waitFor(next,'succeeded');
  const versionPreview=[];
  const callsBeforePreview=model.calls.length, writesBeforePreview=counters.writes;
  for(const [width,height] of [[1440,900],[1024,900],[768,900],[390,844],[320,780]]) {
    const reducedMotion=width===320?'reduce':'no-preference';
    const versionPage=await browser.newPage({viewport:{width,height},reducedMotion});
    try {
      const preview=versionPage.locator('#right-preview');
      await versionPage.goto(host.origin+'/#chat/'+script);
      const toggle=versionPage.getByRole('button',{name:'预览',exact:true});
      if(width<=760)await toggle.press('Enter');
      await preview.getByRole('tab',{name:/^版本/}).press('Enter');
      await preview.locator('.side-row').filter({hasText:'v1'}).getByRole('button').press('Enter');
      await preview.getByRole('button',{name:'查看此版',exact:true}).press('Enter');
      const content=preview.getByRole('tabpanel',{name:'分镜稿'});
      await content.getByText('v1',{exact:true}).waitFor();
      assert.equal(await content.evaluate(el=>document.activeElement===el),true,'打开旧版后聚焦分镜预览 · '+width);
      await versionPage.keyboard.press('Tab');
      assert.equal(await content.locator('.shot-toggle').first().evaluate(el=>document.activeElement===el),true);
      const motion=await content.locator('.tab-in').evaluate(el=>getComputedStyle(el).animationDuration);
      assert.equal(motion,width===320?'0s':'0.18s');
      if(width===390||width===1440)await shot(versionPage,width===390?'手机-打开旧版分镜':'桌面-打开旧版分镜');
      if(width<=760) {
        await versionPage.keyboard.press('Escape');
        await preview.waitFor({state:'hidden'});
        assert.equal(await toggle.evaluate(el=>document.activeElement===el),true);
      }
      versionPreview.push({width,reducedMotion,focusedContent:true,nextTabFocus:'firstShot',motion});
    } finally {await versionPage.close();}
  }
  assert.equal(model.calls.length,callsBeforePreview);
  assert.equal(counters.writes,writesBeforePreview);
  pass('键盘从版本打开旧稿后聚焦所选分镜，Tab 到首镜，窄屏关闭回焦原按钮，不新增运行或写入');
  await page.setViewportSize({width:1440,height:900});
  await page.goto(host.origin+'/#chat/'+script);
  const composer=page.getByRole('textbox',{name:'给自媒体口播发消息'});
  const revisionInstruction='这次只改开场，画面和字幕维持原样。';
  await composer.fill(revisionInstruction);
  const additional=await api('/rooms/'+script+'/materials',{name:'补拍提示.md',content:'开门前标出补拍余量。',authorized:true},201);
  const materials=page.getByRole('tab',{name:/^材料/});
  const versionsTab=page.getByRole('tab',{name:/^版本/});
  const continueRevision=page.getByRole('button',{name:'继续改稿',exact:true});
  await materials.click();
  await page.getByRole('checkbox',{name:'本轮选用 补拍提示.md'}).check();
  await versionsTab.click();
  await page.locator('.side-row').filter({hasText:'v1'}).getByRole('button').click();
  await continueRevision.click();
  assert.equal(await composer.inputValue(),revisionInstruction,'Draft is preserved when binding an earlier revision');
  await page.waitForFunction(()=>document.activeElement?.id==='message');
  await page.getByText('继续修改 v1',{exact:true}).waitFor();
  await page.locator('.composer-files').getByRole('button',{name:'补拍提示.md',exact:true}).waitFor();
  await shot(page,'桌面-旧稿续改');
  const dispatch=page.waitForResponse(response=>response.url().endsWith(runs(script))&&response.request().method()==='POST');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const submitted=await dispatch;
  assert.equal(submitted.status(),202);
  const proposal=await waitFor(await submitted.json(),'waiting_approval');
  assert.deepEqual(proposal.materialIds,[...first.materialIds,additional.id]);
  assert.equal(proposal.base,first.id);
  assert.equal(model.calls.at(-1).materialCount,3);
  assert.deepEqual(proposal.approval.review,{version:3,sourceVersion:1,headVersion:2,
    changes:{shots:[{index:0,fields:['spoken']}],removed:0,title:false,notes:false}});
  const writesBeforeReview=counters.writes;
  for(const [width,height] of [[1440,900],[1024,900],[768,900],[390,844],[320,780]]) {
    await page.setViewportSize({width,height});
    await page.emulateMedia({reducedMotion:width===320?'reduce':'no-preference'});
    await page.goto(host.origin+'/'+target(proposal));
    const card=page.getByRole('region',{name:'本轮写入审批'});
    await card.waitFor();
    const details=await card.innerText();
    assert.match(details,/街角书店开门前/);
    assert.match(details,/书店开门前的 45 秒/);
    assert.match(details,/v1\s*拟保存 v3/);
    assert.match(details,/在 v2 后新增一版/);
    const review=card.getByRole('button',{name:'核对分镜 · 拟写入内容'});
    assert.match(await review.innerText(),/今天，从店主摆好第一排书开始。/);
    await fits(page,width,'.approval-card');
    if(width===1440)await shot(page,'桌面-审批与分镜改动');
    if(width===390)await shot(page,'手机-审批与分镜改动');
    await review.focus();
    await page.keyboard.press('Enter');
    const preview=page.locator('#right-preview');
    await preview.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.activeElement.matches('#right-preview [role=tab][aria-selected=true]'));
    await preview.getByText('待确认 · v3',{exact:true}).waitFor();
    await preview.getByText('改动 1 镜',{exact:true}).waitFor();
    assert.match(await preview.locator('.shot.open').innerText(),/今天，从店主摆好第一排书开始。/);
    if(width===390)await shot(page,'手机-拟写入分镜');
    if(width===320)assert.equal(await preview.evaluate(el=>getComputedStyle(el).animationName),'none');
    if(width<760)await page.keyboard.press('Escape');
    else await preview.getByRole('button',{name:'关闭预览'}).click();
    await preview.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement.matches('.approval-preview'));
  }
  assert.equal(counters.writes,writesBeforeReview);
  await page.getByRole('button',{name:'允许本次写入',exact:true}).click();
  await waitFor(proposal,'succeeded');
  const versions=(await room(script)).artifacts;
  assert.deepEqual(versions.map(version=>version.version),[1,2,3]);
  assert.equal(versions[2].base,first.id);
  assert.equal(versions[2].previous,versions[1].id);
  assert.equal(versions[0].result.segments[0].spoken,first.result.segments[0].spoken);
  assert.equal(counters.writes,writesBeforeReview+1);
  assert.deepEqual(errors,[]);
  pass('在桌面将现有说明和补拍材料带入 v1 续改，审批在 v2 后新增 v3，五种视口可核对并返回原任务');

  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(host.origin+'/#chat/'+script);
  await page.getByRole('button',{name:'另起任务',exact:true}).click();
  const extras=['补拍提示.md'];
  for(const name of ['备用记事A.md','备用记事B.md','备用记事C.md','备用记事D.md']){
    extras.push(name);
    await api('/rooms/'+script+'/materials',{name,content:'待确认的合成补拍备注。',authorized:true},201);
  }
  const mobileDraft='保留原来写好的改稿说明。';
  await composer.fill(mobileDraft);
  const rightPane=page.locator('#right-preview');
  if(!await rightPane.isVisible())await page.getByRole('button',{name:'预览',exact:true}).click();
  await materials.click();
  for(const name of extras)await page.getByRole('checkbox',{name:'本轮选用 '+name}).check();
  await versionsTab.click();
  await page.locator('.side-row').filter({hasText:'v1'}).getByRole('button').click();
  await continueRevision.click();
  await page.getByText('本轮最多选 6 份材料。请先在「材料」取消勾选，再继续改稿。',{exact:true}).waitFor();
  assert.ok(await rightPane.isVisible());
  const overflow=(await room(script)).draft;
  assert.equal(overflow.base,null);
  await materials.click();
  for(const name of extras)assert.ok(await page.getByRole('checkbox',{name:'本轮选用 '+name}).isChecked());
  await page.getByRole('checkbox',{name:'本轮选用 '+extras.at(-1)}).uncheck();
  await versionsTab.click();
  await continueRevision.click();
  await rightPane.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='message');
  assert.equal(await composer.inputValue(),mobileDraft);
  assert.equal(await page.locator('.composer-files > span').count(),6);
  await page.getByRole('button',{name:'已选 6 份',exact:true}).waitFor();
  await page.getByText('继续修改 v1',{exact:true}).waitFor();
  await fits(page,390,'.composer');
  await page.getByText('本轮最多选 6 份材料。请先在「材料」取消勾选，再继续改稿。',{exact:true}).waitFor({state:'hidden'});
  await shot(page,'手机-旧稿续改');
  await page.setViewportSize({width:320,height:780});
  await page.emulateMedia({reducedMotion:'reduce'});
  await fits(page,320,'.composer');
  const limit=AbortSignal.timeout(12000);
  let draftSnapshot;
  for(;;){
    draftSnapshot=(await room(script)).draft;
    if(draftSnapshot.base===first.id&&draftSnapshot.text===mobileDraft)break;
    await delay(80,null,{signal:limit});
  }
  assert.equal(draftSnapshot.attachments.length,6);
  await page.reload();
  assert.equal(await composer.inputValue(),mobileDraft);
  await page.getByText('继续修改 v1',{exact:true}).waitFor();
  pass('窄屏超过六份时保留原草稿及材料，取消勾选后保留说明、回焦输入框，刷新仍可续改 v1');

  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'no-preference'});
  const trigger=page.getByRole('button',{name:'打开工作区导航'});
  const rail=page.locator('#workspace-nav');
  const drawer=page.getByRole('dialog',{name:'工作区导航'});
  await trigger.click();
  await drawer.getByRole('link',{name:'Hyper Bot'}).waitFor();
  await page.waitForFunction(()=>document.activeElement.matches('#workspace-nav .brand'));
  assert.equal(await drawer.evaluate(el=>getComputedStyle(el).transitionDuration),'0.24s');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await drawer.getByRole('link',{name:'维护中心'}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await drawer.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement.matches('.show-nav'));
  assert.equal((await rail.evaluate(el=>getComputedStyle(el).transitionDuration)).split(',')[0],'0.12s');

  await page.emulateMedia({reducedMotion:'reduce'});
  await trigger.click();
  await drawer.waitFor();
  assert.equal(await drawer.evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  await drawer.getByRole('button',{name:'关闭工作区导航'}).click();
  await page.waitForFunction(()=>document.activeElement.matches('.show-nav'));

  await trigger.click();
  await drawer.getByRole('link',{name:'Bot 目录'}).click();
  await page.waitForFunction(()=>document.activeElement.matches('.route-page h1')&&document.activeElement.textContent==='Bot 目录');
  await trigger.click();
  await drawer.getByRole('link',{name:'街角书店开门前',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement.matches('.chat-ident h1')&&document.activeElement.textContent==='自媒体口播');

  await trigger.click();
  await drawer.waitFor();
  await page.setViewportSize({width:1440,height:900});
  await drawer.waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.querySelector('.page-area').inert);
  assert.deepEqual(errors,[]);
  pass('手机导航按 240/120 ms 打开与关闭，键盘在抽屉内循环，关闭回到菜单，选页聚焦标题，宽屏切换恢复交互');

  await page.setViewportSize({width:1024,height:900});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(host.origin+'/#chat/'+script);
  await rightPane.waitFor();
  const motion=await page.evaluate(()=>{
    const root=document.querySelector('.conversation');
    const animations=root.getAnimations({subtree:true}).filter(item=>item.animationName==='view-in');
    const positions=()=>['.rail','.chat-head','.preview-head','.thread-head','.thread-scroll','.compose-wrap']
      .map(selector=>document.querySelector(selector).getBoundingClientRect().top);
    for(const animation of animations){animation.pause();animation.currentTime=0;}
    const start=positions();
    const durations=animations.map(animation=>animation.effect.getComputedTiming().duration);
    for(const [index,animation] of animations.entries())animation.currentTime=durations[index];
    const end=positions();
    for(const animation of animations)animation.finish();
    return {durations,verticalOffsets:start.map((top,index)=>Math.round((top-end[index])*100)/100)};
  });
  assert.deepEqual(motion.durations,[220,220,220]);
  // The rail and both headings stay anchored. Only the conversation body moves.
  assert.deepEqual(motion.verticalOffsets,[0,0,0,5,5,5]);
  pass('会话 220 ms 入场动效仅移动主内容，左侧导航、聊天和预览标题位置稳定');

  const beforeResize=(await room(script)).draft;
  const callsBeforeResize=model.calls.length;
  const resized=[];
  for(const [width,reducedMotion] of [[390,'no-preference'],[320,'reduce']]) {
    await page.setViewportSize({width:1024,height:900});
    await page.emulateMedia({reducedMotion});
    await materials.click();
    const file=rightPane.getByRole('button',{name:/拍摄笔记\.md/});
    await file.click();
    const source=rightPane.locator('.source-paper');
    await source.getByRole('heading',{name:'拍摄笔记.md',exact:true}).waitFor();
    await file.focus();
    await page.setViewportSize({width,height:844});
    const previewDialog=page.getByRole('dialog',{name:'会话预览'});
    await previewDialog.waitFor();
    assert.equal(await materials.getAttribute('aria-selected'),'true');
    assert.equal(await file.getAttribute('aria-pressed'),'true');
    assert.equal(await file.evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('.chat').evaluate(el=>el.inert),true);
    await source.getByRole('heading',{name:'拍摄笔记.md',exact:true}).waitFor();
    await fits(page,width,'#right-preview');
    if(reducedMotion==='reduce')assert.equal(await previewDialog.evaluate(el=>getComputedStyle(el).animationName),'none');
    if(width===390)await shot(page,'手机-缩窄后继续读材料');
    await page.keyboard.press('Escape');
    await rightPane.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement.matches('.preview-toggle'));
    assert.equal(await composer.inputValue(),beforeResize.text);
    resized.push({width,reducedMotion,selectedMaterial:'拍摄笔记.md',readingFocus:true,restoredFocus:true});
  }
  await page.setViewportSize({width:1024,height:900});
  await rightPane.waitFor();
  await composer.focus();
  await page.setViewportSize({width:390,height:844});
  await rightPane.waitFor({state:'hidden'});
  assert.equal(await composer.evaluate(el=>el===document.activeElement),true);
  assert.equal(await composer.inputValue(),beforeResize.text);
  assert.deepEqual((await room(script)).draft,beforeResize);
  const resizeRequests=model.calls.length-callsBeforeResize;
  assert.equal(resizeRequests,0);
  assert.deepEqual(errors,[]);
  pass('桌面读材料后缩窄保留当前标签、原文和焦点，关预览回到按钮，编辑草稿时缩窄继续留在输入框');

  const compactRoom=await openRoom('media','短窗口材料与审批');
  const compactRun=await waitFor(await start(compactRoom),'waiting_approval');
  const callsBeforeReview=model.calls.length;
  const longDraft=Array(16).fill('保留正在编辑的下一轮分镜说明。').join('\n');
  const beforeUpload=(await room(compactRoom)).draftToken;
  await api('/rooms/'+compactRoom+'/draft',{text:longDraft,attachments:[],base:null,draftToken:beforeUpload});
  const invalidFiles=Array.from({length:6},(_,index)=>({
    name:'附件'+(index+1)+'开门前采访和镜头说明'.repeat(14)+'.pdf',
    mimeType:'application/pdf',buffer:Buffer.from('test fixture')
  }));
  const uploadAlerts=[];
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const [width,height] of [[420,580],[320,580]]) {
    await page.setViewportSize({width,height});
    await page.goto(host.origin+'/'+target(compactRun));
    await composer.waitFor();
    await page.locator('input[type=file]').setInputFiles(invalidFiles);
    const alert=page.getByRole('alert').filter({hasText:'请选择 64 KB 以内的 TXT 或 Markdown。'});
    await alert.waitFor();
    assert.ok((await alert.innerText()).startsWith('请选择 64 KB 以内的 TXT 或 Markdown。'));
    assert.ok((await alert.innerText()).includes(invalidFiles.at(-1).name));
    await fits(page,width,'.form-error');
    const dimensions=await alert.evaluate(el=>({height:el.clientHeight,contentHeight:el.scrollHeight,
      conversationHeight:document.querySelector('.thread-scroll').clientHeight}));
    assert.ok(dimensions.conversationHeight>=100&&dimensions.height<dimensions.contentHeight,JSON.stringify(dimensions));
    await alert.focus();
    await page.keyboard.press('PageDown');
    await page.waitForFunction(()=>document.querySelector('.form-error').scrollTop>0);
    assert.equal(await composer.inputValue(),longDraft);
    assert.deepEqual((await room(compactRoom)).draft.attachments,[]);
    uploadAlerts.push({width,height,...dimensions,keyboardScroll:true});
  }
  assert.equal(model.calls.length,callsBeforeReview);

  const materialsForDraft=[];
  for(let index=1;index<=6;index++) {
    const name='附件'+index+'开门前采访和镜头说明'.repeat(14)+'.md';
    const {id}=await api('/rooms/'+compactRoom+'/materials',{
      name,content:'合成材料，开门前的采访与镜头说明。',authorized:true
    },201);
    materialsForDraft.push({id,name});
  }
  const compactDraft=(await room(compactRoom)).draftToken;
  await api('/rooms/'+compactRoom+'/draft',{text:longDraft,attachments:materialsForDraft.map(file=>file.id),base:null,draftToken:compactDraft});
  const compactFrames=[];
  for(const [width,height] of [[1024,640],[420,580],[390,640],[320,580]]) {
    await page.setViewportSize({width,height});
    await page.goto(host.origin+'/#bots');
    await page.getByRole('link',{name:'查看写入审批 · 短窗口材料与审批',exact:true}).click();
    await page.waitForURL(url=>url.hash===target(compactRun));
    const compactApproval=page.getByRole('region',{name:'本轮写入审批'});
    await compactApproval.waitFor();
    await page.waitForFunction(id=>document.activeElement.closest('.task-anchor')?.id==='task-'+id,compactRun.id);
    await page.getByRole('alert').filter({hasText:'请选择 64 KB 以内的 TXT 或 Markdown。'}).waitFor();
    await fits(page,width,'.composer');
    const frame=await page.evaluate(()=>{
      const thread=document.querySelector('.thread-scroll');
      const tray=document.querySelector('.composer-files');
      const notice=document.querySelector('.compose-wrap > .form-error');
      const send=document.querySelector('.composer button[type=submit]').getBoundingClientRect();
      const bounds=thread.getBoundingClientRect();
      const approval=document.querySelector('.approval-card').getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,conversationHeight:thread.clientHeight,attached:tray.children.length,
        attachmentsHeight:tray.clientHeight,attachmentsScrollable:tray.scrollHeight>tray.clientHeight,
        noticeHeight:notice.clientHeight,noticeScrollable:notice.scrollHeight>notice.clientHeight,
        sendInsideViewport:send.top>=0&&send.bottom<=innerHeight+1,
        approvalIntersection:Math.max(0,Math.min(approval.bottom,bounds.bottom)-Math.max(approval.top,bounds.top))};
    });
    assert.equal(frame.attached,6);
    assert.ok(frame.attachmentsScrollable&&frame.noticeScrollable&&frame.sendInsideViewport,JSON.stringify(frame));
    assert.ok(frame.conversationHeight>=100&&frame.approvalIntersection>0,JSON.stringify(frame));
    compactFrames.push(frame);
    if(width===420)await shot(page,'窄窗-长材料与审批');
  }
  const tray=page.getByRole('group',{name:'本轮选用的材料'});
  const firstFile=tray.getByRole('button',{name:materialsForDraft[0].name,exact:true});
  const lastMaterial=materialsForDraft.at(-1);
  const lastFile=tray.getByRole('button',{name:lastMaterial.name,exact:true});
  const remove=tray.getByRole('button',{name:'移除 '+lastMaterial.name,exact:true});
  await firstFile.focus();
  for(let index=0;index<11;index++)await page.keyboard.press('Tab');
  assert.equal(await remove.evaluate(el=>el===document.activeElement),true);
  assert.ok(await tray.evaluate(el=>el.scrollTop>0));
  assert.equal(await lastFile.getAttribute('title'),lastMaterial.name);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await rightPane.locator('.source-paper').getByRole('heading',{name:lastMaterial.name,exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await rightPane.waitFor({state:'hidden'});
  await page.waitForFunction(name=>document.activeElement.getAttribute('title')===name,lastMaterial.name);
  await page.keyboard.press('Tab');
  assert.equal(await remove.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter');
  await remove.waitFor({state:'hidden'});
  const persist=AbortSignal.timeout(10000);
  let afterRemoval;
  for(;;){
    afterRemoval=await room(compactRoom);
    if(afterRemoval.draft.attachments.length===5)break;
    await delay(100,null,{signal:persist});
  }
  assert.equal(afterRemoval.draft.text,longDraft);
  assert.deepEqual(afterRemoval.draft.attachments,materialsForDraft.slice(0,-1).map(file=>file.id));
  assert.ok(afterRemoval.materials.some(file=>file.id===lastMaterial.id&&!file.endedAt));
  assert.equal(afterRemoval.runs.find(run=>run.id===compactRun.id).state,'waiting_approval');
  const originalApproval=page.getByRole('region',{name:'本轮写入审批'});
  assert.match(await originalApproval.innerText(),new RegExp(compactRun.id.slice(0,8)));
  await originalApproval.getByRole('button',{name:'拒绝写入',exact:true}).click();
  await waitFor(compactRun,'cancelled');
  await page.waitForFunction(()=>!document.querySelector('.composer button[type=submit]').disabled);
  assert.equal(await composer.inputValue(),longDraft);
  assert.equal(model.calls.length,callsBeforeReview);
  assert.deepEqual(errors,[]);
  const compactComposer={frames:compactFrames,uploadAlerts,filenameLength:lastMaterial.name.length,openedFullName:true,removedByKeyboard:true,
    draftPreserved:true,originalApproval:'cancelled',newModelRequests:model.calls.length-callsBeforeReview};
  pass('长附件与批量上传提示各自滚动，短窗口保留消息和发送区，键盘可以查看材料并处理原审批');

  const report=process.env.HYPER_BOT_TEST_REPORT;
  if(report) {
    const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    await writeFile(report,JSON.stringify({version,checkedAt:new Date().toISOString(),engine,checks,counters,
      viewport:{motion,resized,composerRetained:true,modelRequests:resizeRequests},versionPreview,compactComposer},null,2)+'\n');
  }
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}

