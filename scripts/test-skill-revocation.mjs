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
const loadHost=directory=>import(pathToFileURL(join(directory,'server','http.mjs')));
const {launch}=await loadHost(root);
const data=await mkdtemp(join(tmpdir(),'hb-skill-retirement-'));
const pictures=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const withBrowser=!process.argv.includes('--no-ui');
const checks=[];
const sizes=[[1440,900],[1024,768],[768,1024],[390,844],[320,750]];
const quotes=['清晨开门前先查一遍墙上的展签。','展签顺序有误时，记下编号后再调换。'];
const skillSource={slug:'on-site-quotes',version:'1.0.0',name:'现场原话核对',origin:'Hyper Bot 合成验收',
  reviewed:true,content:'# 现场原话核对\n在归纳时使用材料中的连续原话。若有不同说法，请明确标记为待确认。',references:[]};
const pressSample={title:'展签核对演练',prompt:'按展签原话归纳工作步骤，说明有什么仍需确认。',
  files:quotes.map((content,index)=>({name:'展签记录'+(index+1)+'.txt',content})),
  useInChat:true,expectedQuote:quotes[0],authorized:true};

let host,browser,blockedModel;
const model=await modelFixture({beforeResponse:(prompt,response)=>{
  const held=blockedModel;
  if(!held || !prompt.text.includes(held.marker))return;
  held.entered.resolve();
  return Promise.race([held.release.promise,new Promise(resolve=>response.once('close',resolve))]);
}});
const options={data,upstream:model.origin,providerKey:'fixture',timeoutMs:60000};
const pass=label=>{checks.push(label);console.log('OK '+label);};

async function api(route,body,status) {
  const request=body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},
    body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...request,signal:AbortSignal.timeout(70000)});
  const value=await response.json();
  if(status)assert.equal(response.status,status,JSON.stringify(value));
  else assert.ok(response.ok,JSON.stringify(value));
  return value;
}
async function until(read,ready) {
  const timeout=AbortSignal.timeout(66000);
  for(;;){
    const value=await read();
    if(ready(value))return value;
    await delay(140,null,{signal:timeout});
  }
}
const view=()=>api('/workspace');
const room=id=>api('/rooms/'+id);
const version=(bot,action)=>'/bots/'+bot.id+'/'+bot.revision+'/'+action;
const revoke=(skill,body={confirmed:true},status)=>api('/skills/'+encodeURIComponent(skill)+'/revoke',body,status);
const listStatus=(state,bot)=>state.bots.find(row=>row.id===bot.id&&row.revision===bot.revision);
const artifactRecord=id=>api('/artifacts/'+id+'/export');
const events=id=>api('/runs/'+id+'/events');

async function draft(id,kind,skill,extra={}) {
  return api('/bots',{id,kind,name:kind==='script'?'口播规则演练':'简报规则演练',
    driver:'dsh-web',description:'按已授权的现场原话整理本次的书店或展陈内容。',
    skills:[kind==='script'?'talking-script':'material-brief',skill],...extra},201);
}
async function verify(bot) {
  const result=await api(version(bot,'verify'),{});
  assert.equal(result.ok,true,JSON.stringify(result));
  return result;
}
const publish=bot=>api(version(bot,'publish'),{});
async function open(bot,title) {
  return (await api('/rooms',{botId:bot.id,revision:bot.revision,title,example:true},201)).id;
}
async function send(roomId,text,{attachments,base,status=202}={}) {
  const current=await room(roomId);
  return api('/rooms/'+roomId+'/runs',{text,attachments:attachments??current.draft.attachments,base,
    draftToken:current.draftToken,authorized:true,clientRequestId:randomUUID()},status);
}
const decision=(run,allow=true,status=202)=>api('/runs/'+run.id+'/decide',{
  id:run.approval.id,digest:run.approval.digest,allow
},status);
const terminal=new Set(['succeeded','cancelled','interrupted','failed']);
function phase(roomId,id,expected) {
  return until(async()=>(await room(roomId)).runs.find(run=>run.id===id),run=>{
    if(terminal.has(run?.state)&&!expected.includes(run.state))throw Error(JSON.stringify(run));
    return expected.includes(run?.state);
  });
}
async function picture(page,name) {
  if(!pictures)return;
  await mkdir(pictures,{recursive:true});
  await page.screenshot({path:join(pictures,name+'.png'),animations:'disabled'});
}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const gate=()=>({entered:Promise.withResolvers(),release:Promise.withResolvers()});
const reached=held=>Promise.race([held.entered.promise,delay(25000,null,{ref:false}).then(()=>{
  throw Error('The fixture did not reach its pause point');
})]);

try {
  host=await launch({options});
  const shared=(await api('/skills',skillSource,201)).id;
  const adopted=(await api('/skills',{...skillSource,version:'1.0.1',name:'现场原话核对修订'},201)).id;
  const media=await draft('media','script',shared,{name:'自媒体口播'});
  const brief=await draft('brief','brief',shared,{name:'素材简报',driver:'hermes',fixture:pressSample});
  const qualified=await draft('source-proof','brief',shared,{name:'展陈材料校对'});
  for(const bot of [media,brief]){await verify(bot);await publish(bot);}
  await verify(qualified);

  const briefRoom=await open(brief,'已完成的展签简报');
  const sentBrief=await send(briefRoom,'核对志愿者提供的展签记录。');
  const priorBrief=await phase(briefRoom,sentBrief.id,['succeeded']);
  const mediaRoom=await open(media,'已保存的书店首稿');
  const currentMedia=await room(mediaRoom),continuationMaterial=currentMedia.draft.attachments;
  const first=await send(mediaRoom,'用书店的文字写四镜口播。');
  await decision(await phase(mediaRoom,first.id,['waiting_approval']));
  const priorScript=await phase(mediaRoom,first.id,['succeeded']);
  const next=await send(mediaRoom,'这次只改开场',{attachments:continuationMaterial,base:priorScript.artifact});
  const pending=await phase(mediaRoom,next.id,['waiting_approval']);
  pass('撤销前，含两项 Skill 的 DSH 口播和 Hermes 简报实际生成，口播已在工作台保存首版并产生第二版待审批。');

  assert.equal((await revoke(shared,{confirmed:false},422)).code,'validation');
  const snapshot=await view(),registered=snapshot.skills.find(skill=>skill.id===shared);
  assert.equal(registered.revokedAt,undefined);
  assert.equal(snapshot.active.approval.status,'pending');
  const callCount=model.calls.length;
  let page;
  if(withBrowser){
    const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM,args:['--disable-gpu']});
    page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
    await page.goto(host.origin+'/#manage/skills');
    const toggle=button(page,'撤销 现场原话核对 1.0.0');
    const dialog=page.getByRole('dialog',{name:'撤销 Skill 版本'});
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});
      await toggle.click();
      await dialog.waitFor();
      await page.waitForFunction(()=>document.activeElement.textContent==='取消');
      assert.deepEqual(await dialog.locator('li').allTextContents(),['自媒体口播 r2','素材简报 r2']);
      assert.ok(await dialog.getByText('1 个候选版本需换用 Skill 后再验证。',{exact:true}).isVisible());
      await page.keyboard.press('Tab');
      assert.equal(await button(dialog,'确认撤销').evaluate(node=>node===document.activeElement),true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await button(dialog,'取消').evaluate(node=>node===document.activeElement),true);
      const dimensions=await dialog.evaluate(node=>{
        const pane=document.querySelector('.route-page');
        return {visible:node.getBoundingClientRect().width,document:document.documentElement.scrollWidth,
          viewport:window.innerWidth,enter:getComputedStyle(node).animationDuration,
          hasOverflow:node.scrollWidth>node.clientWidth||pane.scrollWidth>pane.clientWidth||pane.scrollLeft!==0};
      });
      assert.ok(dimensions.visible>0 && dimensions.document<=dimensions.viewport && !dimensions.hasOverflow,JSON.stringify(dimensions));
      assert.equal(dimensions.enter,'0.24s');
      const size=await button(dialog,'确认撤销').boundingBox();
      if(width<=750)assert.ok(size.height>=44);
      if(width===1440)await picture(page,'桌面-Skill撤销确认');
      if(width===390)await picture(page,'手机-Skill撤销确认');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await toggle.click();
    await dialog.waitFor();
    assert.equal(await dialog.evaluate(node=>getComputedStyle(node).animationDuration),'0s');
    await button(dialog,'确认撤销').click();
    await dialog.waitFor({state:'hidden'});
    const revokedRow=page.locator('.skill-row').filter({hasText:'已撤销'});
    await revokedRow.waitFor();
    await page.waitForFunction(()=>document.activeElement.tagName==='H3'&&document.activeElement.textContent==='现场原话核对');
    pass('维护页确认列出受影响的 Bot 版次，Esc 回焦，五种宽度可读，240 ms 打开和减少动效通过。');
  } else await revoke(shared);

  const stopped=await phase(mediaRoom,pending.id,['interrupted']);
  assert.equal(stopped.approval.status,'revoked');
  assert.match(stopped.error,/Skill 已撤销/);
  assert.equal((await decision(pending,true,409)).code,'approval_scope');
  assert.equal((await events(pending.id)).some(event=>event.kind==='workbench_submit_started'),false);
  const state=await view();
  const revokedSkill=state.skills.find(skill=>skill.id===shared);
  assert.ok(revokedSkill.revokedAt&&revokedSkill.digest===registered.digest);
  for(const bot of [media,brief]){
    const row=listStatus(state,bot);
    assert.ok(row.skillRevoked&&!row.sampleReady);
    assert.equal(row.status,'disabled');
    assert.equal(row.history.exportable,1);
    assert.match(row.blocked,/已撤销/);
    await api('/rooms',{botId:bot.id,revision:bot.revision,title:'不得再新建'},409);
    await api(version(bot,'restore'),{},503);
  }
  assert.equal((await room(mediaRoom)).artifacts.length,1);
  assert.match((await artifactRecord(priorScript.artifact)).markdown,/书店/);
  assert.ok((await artifactRecord(priorBrief.artifact)).markdown);
  assert.equal((await send(mediaRoom,'拒绝新运行',{attachments:continuationMaterial,status:409})).code,'bot_disabled');
  assert.equal((await send(briefRoom,'旧版拒绝新运行',{attachments:priorBrief.materialIds,status:409})).code,'bot_disabled');
  assert.equal(model.calls.length,callCount);
  pass('一次撤销同时停用两种 Harness 上的 Bot；迟到批准和新增任务未调用模型或写入工作台，原稿和简报都能导出。');

  const pendingBot=listStatus(state,qualified);
  assert.equal(pendingBot.status,'draft');
  assert.ok(pendingBot.sample.ok&&!pendingBot.sampleReady);
  await api(version(qualified,'publish'),{},503);
  await api(version(qualified,'verify'),{},503);
  const reused=await revoke(shared);
  assert.equal(reused.revokedAt,revokedSkill.revokedAt);
  assert.equal(host.store.read().skills.find(skill=>skill.id===shared).content,'');
  assert.equal((await api('/skills',skillSource,409)).code,'request_failed');
  const invalid={id:'wrong-skill',kind:'brief',name:'错误引用',driver:'dsh-web',description:'已撤销的版本不可继续装配。',skills:[shared]};
  assert.equal((await api('/bots',invalid,409)).code,'skill_revoked');
  assert.equal(model.calls.length,callCount);
  pass('撤销前通过样例的候选也停止验证和启用；保留原摘要和版号，同版重复导入无法恢复。');

  let replacement;
  if(withBrowser){
    await page.setViewportSize({width:1440,height:900});
    await page.goto(host.origin+'/#chat/'+mediaRoom);
    const versionLink=page.getByRole('link',{name:'查看 Bot 版本',exact:true});
    await versionLink.waitFor();
    assert.equal(await button(page,'发送消息').isDisabled(),true);
    await versionLink.click();
    const mediaCard=page.locator('.manage-card').filter({has:page.getByRole('heading',{name:'自媒体口播 r2',exact:true})});
    await mediaCard.getByRole('link',{name:'基于此版装配'}).click();
    const retired=page.getByRole('checkbox',{name:/现场原话核对 · 1.0.0/});
    const save=button(page,'保存下一候选版');
    assert.ok(await retired.isChecked());
    assert.ok(await save.isDisabled());
    await picture(page,'桌面-撤销后重新装配');
    await retired.uncheck();
    await page.getByRole('checkbox',{name:/现场原话核对修订 · 1.0.1/}).check();
    await save.click();
    await page.getByRole('heading',{name:'自媒体口播 r3',exact:true}).waitFor();
    await page.waitForFunction(()=>document.activeElement.textContent.includes('r3'));
    replacement=listStatus(await view(),{id:media.id,revision:3});
  } else replacement=await draft(media.id,'script',adopted,{name:media.name,sourceRevision:media.revision});
  assert.deepEqual(replacement.skills,['talking-script',adopted]);
  assert.equal(replacement.sourceRevision,media.revision);
  await api(version(replacement,'publish'),{},409);
  await verify(replacement);await publish(replacement);
  const refilled=await open(replacement,'新规则口播演练');
  const fresh=await send(refilled,'写四镜，末镜留声。');
  await decision(await phase(refilled,fresh.id,['waiting_approval']));
  await phase(refilled,fresh.id,['succeeded']);
  pass('基于旧 Bot 换新 Skill 需要再验证，两项 Skill 的新版经实际工作台写入通过。');

  const cancellable=(await api('/skills',{...skillSource,slug:'stop-on-site',name:'可撤销规则'},201)).id;
  const runningBot=await draft('open-notes','brief',cancellable);
  await verify(runningBot);await publish(runningBot);
  const runningRoom=await open(runningBot,'正在执行的版本');
  blockedModel={...gate(),marker:'只核对手记 167'};
  const live=await send(runningRoom,blockedModel.marker);
  await reached(blockedModel);
  await revoke(cancellable);
  blockedModel.release.resolve();blockedModel=null;
  const evicted=await phase(runningRoom,live.id,['interrupted','cancelled']);
  assert.equal(evicted.stop.trigger,'skill');
  assert.equal(evicted.artifact,undefined);
  assert.match(evicted.error,/Skill 已撤销/);
  const logged=await events(live.id);
  assert.ok(logged.some(event=>event.kind==='stop_requested'&&event.data.role==='maintainer'));
  pass('撤销执行中的 Skill 会请求停止，迟到结果不会形成新成果，运行回执记录维护操作。');

  const testSkill=(await api('/skills',{...skillSource,slug:'test-on-site',name:'候选试验规则'},201)).id;
  const verifying=await draft('verifying-notes','brief',testSkill,{fixture:{...pressSample,prompt:'候选隔离核对 302'}});
  blockedModel={...gate(),marker:'候选隔离核对 302'};
  const verification=api(version(verifying,'verify'),{});
  await reached(blockedModel);
  await revoke(testSkill);
  blockedModel.release.resolve();blockedModel=null;
  const aborted=await verification;
  assert.equal(aborted.code,'skill_revoked');
  assert.equal(aborted.ok,false);
  assert.equal(host.store.read().verifications.find(record=>record.id===aborted.runId).state,'interrupted');
  await api(version(verifying,'publish'),{},503);
  pass('进行中的候选验证因 Skill 撤销中断，回执保留失败原因，候选不能启用。');

  const beforeSkill=(await api('/skills',{...skillSource,slug:'write-before',name:'写入前试验规则'},201)).id;
  const beforeBot=await draft('write-first','script',beforeSkill);
  await verify(beforeBot);await publish(beforeBot);
  const wb=host.app.workbench;
  const realCommit=wb.commit.bind(wb);
  const beforeGate=gate();
  const guardedRoom=await open(beforeBot,'批准后未写入的书店稿');
  const guarded=await send(guardedRoom,'保留门口的招牌声，写四镜。');
  const approval=await phase(guardedRoom,guarded.id,['waiting_approval']);
  wb.commit=async(plan,onSubmit,signal)=>{
    beforeGate.entered.resolve();
    await Promise.race([beforeGate.release.promise,delay(12000,null,{ref:false})]);
    return realCommit(plan,onSubmit,signal);
  };
  await decision(approval);
  await reached(beforeGate);
  await revoke(beforeSkill);
  beforeGate.release.resolve();
  const unstarted=await phase(guardedRoom,guarded.id,['interrupted']);
  await until(()=>host.app.jobs.has(guarded.id),value=>!value);
  wb.commit=realCommit;
  assert.equal(unstarted.commitStarted,undefined);
  assert.equal((await events(guarded.id)).some(event=>event.kind==='workbench_submit_started'),false);
  assert.equal((await room(guardedRoom)).artifacts.length,0);

  const afterSkill=(await api('/skills',{...skillSource,slug:'write-after',name:'已提交试验规则'},201)).id;
  const afterBot=await draft('write-second','script',afterSkill);
  await verify(afterBot);await publish(afterBot);
  const workbenchRequests=wb.request.bind(wb);
  const writtenGate=gate();
  let writes=0;
  wb.request=async(method,route,...args)=>{
    const reply=await workbenchRequests(method,route,...args);
    if(method==='POST' && route.endsWith('/artifacts')){
      writes++;writtenGate.entered.resolve();
      await Promise.race([writtenGate.release.promise,delay(12000,null,{ref:false})]);
    }
    return reply;
  };
  const writtenRoom=await open(afterBot,'已写入等待回执的书店稿');
  const written=await send(writtenRoom,'先找钥匙开门的画面，再写四镜。');
  await decision(await phase(writtenRoom,written.id,['waiting_approval']));
  await reached(writtenGate);
  await revoke(afterSkill);
  writtenGate.release.resolve();
  const settled=await phase(writtenRoom,written.id,['succeeded']);
  assert.ok(settled.artifact&&settled.commitStarted);
  assert.equal(writes,1);
  wb.request=workbenchRequests;
  pass('写入开始前撤销会中断本轮；工作台已提交时沿用原回执，恰好保留一份结果。');

  await browser?.close();browser=null;
  const last=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  let rollback=null;
  if(last){
    await host.close();
    const previous=await loadHost(resolve(last));
    host=await previous.launch({options});
    assert.equal((await room(mediaRoom)).artifacts[0].id,priorScript.artifact);
    await artifactRecord(priorBrief.artifact);
    const revocationAware=listStatus(await view(),media).skillRevoked;
    assert.equal((await api('/bots',invalid,409)).code,revocationAware?'skill_revoked':'skill_integrity');
    await api(version(media,'restore'),{},revocationAware?503:409);
    const active=listStatus(await view(),replacement);
    assert.equal(active.status,'enabled');
    const {version:previousVersion}=JSON.parse(await readFile(join(last,'package.json'),'utf8'));
    rollback={version:previousVersion,oldScript:priorScript.artifact,oldBrief:priorBrief.artifact,activeRevision:active.revision};
    await host.close();
    host=await launch({options});
    assert.equal((await view()).skills.find(skill=>skill.id===shared).revokedAt,revokedSkill.revokedAt);
    assert.equal((await room(mediaRoom)).runs.find(run=>run.id===pending.id).approval.status,'revoked');
    pass('回滚后仍可打开旧稿和新版 Bot，原 Skill 无法再装配。升级回来可核对撤销时刻及旧审批状态。');
  }
  const {version:applicationVersion}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const report={applicationVersion,mode:'真实 DSH Web Host、Hermes ACP 和 Self Media Workbench，模型协议夹具',
    checks,revokedAt:revokedSkill.revokedAt,revokedSkill:shared,digest:revokedSkill.digest,
    referenceCandidates:[media,brief,qualified].map(({id,revision,driver})=>({id,revision,driver})),
    replacement:{id:replacement.id,revision:replacement.revision},modelRequests:model.calls.length,rollback};
  if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  blockedModel?.release.resolve();
  await browser?.close();
  await host?.close();
  await model.close();
}
