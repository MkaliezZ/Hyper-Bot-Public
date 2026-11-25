import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { modelFixture, sample } from '../test/model-fixture.mjs';

const root=resolveApp(process.env.HYPER_BOT_TEST_APP_ROOT);
const previous=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
assert.ok(previous,'请指定已解压的上一版 resources/app 目录。');
const readApp=dir=>import(pathToFileURL(path.join(dir,'server','http.mjs')).href);
const [current,old,configModule]=await Promise.all([readApp(root),readApp(previous),
  import(pathToFileURL(path.join(root,'server','config.mjs')).href)]);
const vb=dir=>readFile(path.join(dir,'package.json'),'utf8').then(JSON.parse).then(row=>row.version);
const [version,previousVersion]=await Promise.all([vb(root),vb(previous)]);
const config=await configModule.configFor({providerKey:'workflow-fixture'});
assert.ok(config.workbench.ok,config.workbench.reason);

const isolation=await mkdtemp(path.join(tmpdir(),'hb-domain-'));
const checkout=path.join(isolation,'workbench');
const exec=promisify(execFile);
const git=(cwd,...args)=>exec('git',['-c','core.fsmonitor=false','-C',cwd,...args],
  {windowsHide:true,timeout:50000,maxBuffer:128*1024});
const gitPath=async name=>(await git(config.workbenchRoot,'rev-parse','--path-format=absolute','--git-path',name)).stdout.trim();
const shallow=await readFile(await gitPath('shallow')).catch(error=>{
  if(error.code!=='ENOENT')throw error;
  return null;
});
if(shallow) {
  // Keep an independent index and files while reading the portable repository's pinned objects.
  await mkdir(checkout);
  await git(checkout,'init','--quiet');
  const alternatives=(await gitPath('objects')).split(path.sep).join('/');
  await writeFile(path.join(checkout,'.git','objects','info','alternates'),alternatives+'\n');
  await writeFile(path.join(checkout,'.git','shallow'),shallow);
  await git(checkout,'-c','core.autocrlf=false','checkout','--quiet','--detach',config.workbench.revision);
} else {
  await git(config.workbenchRoot,'clone','--no-hardlinks','--local',config.workbenchRoot,checkout);
}
const reference=path.join(checkout,'skills/self-media-workflow/references/script.md');
const original=await readFile(reference);
const checker=path.join(checkout,'skills/self-media-workflow/scripts/script_check.py');
process.env.HYPER_BOT_WORKBENCH_ROOT=checkout;
process.env.HYPER_BOT_WORKBENCH_PYTHON=config.workbenchPython;

const observedMethods=[];
const spokenFixture='我先摆好门口那排书，再穿过柜台去开灯，最后回头把书脊从左往右理齐。'.repeat(4);
const sampleClaim='因为开灯，转化率提升了50%';
let malformed=false,dense=false,reviewSample=false;
const model=await modelFixture({
  observe:({text})=>observedMethods.push(text.includes('# Script and timing')),
  respond(input) {
    const output=sample(input);
    if (reviewSample) {
      const [first,second]=output.segments;
      first.spoken='店主说：'+first.spoken;
      first.evidence[0].quote=first.spoken;
      second.subtitle=sampleClaim+'。';
    }
    if (malformed) output.segments[0].spoken+='合成测试字符\uD800';
    if (dense) {
      output.segments[0].spoken=spokenFixture;
      output.segments[1].start=7;
    }
    return output;
  }
});
const options={data:path.join(isolation,'state'),providerKey:'workflow-fixture',upstream:model.origin};
const checks=[],widths=[1440,1024,768,390,320];
const check=label=>{checks.push(label);console.log('OK '+label);};
const open=module=>module.launch({options});
const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const reportPath=process.env.HYPER_BOT_TEST_REPORT;
const ui=!process.argv.includes('--no-ui');
const form={id:'domain-oral',name:'工作台流程口播',description:'按固定版工作台规则生成可续改的口播分镜。',
  kind:'script',driver:'dsh-web',skills:[]};
const baseFlow='workbench-script';
let host,browser,page,legacyRoom;
const legacyScript={...form,id:'old-script-check',name:'上一版候选检查',skills:['talking-script']};
let legacyPublished,legacyDraft;

function resolveApp(value) {
  return path.resolve(value??fileURLToPath(new URL('../',import.meta.url)));
}
async function api(route,body,status=200) {
  const init=body===undefined?{headers:{'X-Hyper-Bot':'1'}}:
    {method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...init,signal:AbortSignal.timeout(100000)});
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
}
const room=id=>api('/rooms/'+id);
const bot=async id=>(await api('/workspace')).bots.find(row=>row.id===id);
const action=(name,id=form.id)=>'/bots/'+id+'/1/'+name;
async function createRoom(id) {
  return (await api('/rooms',{botId:id,revision:1,title:'书店口播演练',example:true},201)).id;
}
function runInput(draft,text=draft.text) {
  return {text,attachments:draft.attachments,base:null,clientRequestId:randomUUID(),authorized:true};
}
async function waitRun(id,expected,runId) {
  const signal=AbortSignal.timeout(60000);
  for (;;) {
    const view=await room(id);
    const run=runId?view.runs.find(row=>row.id===runId):view.runs.at(-1);
    if (run?.state===expected) return {view,run};
    if (run&&['succeeded','interrupted','cancelled','failed'].includes(run.state)) throw new Error(run.error??run.state);
    await pause(150,null,{signal});
  }
}
async function shot(name) {
  if (!shots) return;
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:path.join(shots,name+'.png'),animations:'disabled'});
}
async function composeWithBrowser() {
  const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM??undefined});
  page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(host.origin+'/#manage/compose');
  await page.getByRole('combobox',{name:'成果类型'}).selectOption('script');
  const selector=page.getByRole('combobox',{name:'规则来源'});
  const flowSource=page.getByText('来源提交',{exact:false});
  assert.equal(await selector.inputValue(),'');
  await selector.selectOption(baseFlow);
  await flowSource.waitFor();
  assert.equal(await flowSource.evaluate(el=>getComputedStyle(el).animationDuration),'0.18s');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.ok(await flowSource.evaluate(el=>parseFloat(getComputedStyle(el).animationDuration)<0.002));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('combobox',{name:'Harness',exact:true}).selectOption('dsh');
  await selector.waitFor({state:'hidden'});
  await page.getByRole('combobox',{name:'Harness',exact:true}).selectOption('dsh-web');
  assert.equal(await selector.inputValue(),'');
  await selector.selectOption(baseFlow);
  await page.getByLabel('Bot 名称').fill(form.name);
  await page.getByLabel('稳定 ID').fill(form.id);
  await page.getByLabel('用途说明').fill(form.description);
  for (const width of widths) {
    await page.setViewportSize({width,height:width>760?900:844});
    await selector.scrollIntoViewIfNeeded();
    const box=await selector.boundingBox();
    assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.height>=44);
    if (width<=480) {
      const harness=await page.getByRole('combobox',{name:'Harness',exact:true}).boundingBox();
      assert.ok(harness.width>=width-96);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    await selector.focus();
    assert.equal(await selector.evaluate(el=>el===document.activeElement),true);
    if (width===1440 || width===390) await shot((width===1440?'桌面':'手机')+'-装配工作台流程');
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'保存候选版本'}).click();
  await page.getByRole('heading',{name:form.name+' r1',exact:true}).waitFor();
  check('装配页五种宽度、180 ms 状态动效、减少动效、键盘焦点及切换 Harness 清除旧选择通过');
}

try {
  host=await open(old);
  const previousHasFlow=(await api('/workspace')).drivers.some(driver=>driver.workflows?.some(item=>item.id===baseFlow));
  if (!previousHasFlow) {
    const legacy={...form,id:'legacy-brief',name:'旧版简报流程',kind:'brief',driver:'hermes'};
    await api('/bots',legacy,201);
    assert.equal((await api(action('verify',legacy.id),{})).ok,true);
    await api(action('publish',legacy.id),{});
    legacyRoom=await createRoom(legacy.id);
  } else {
    legacyPublished=await api('/bots',legacyScript,201);
    assert.equal((await api(action('verify',legacyScript.id),{})).ok,true);
    await api(action('publish',legacyScript.id),{});
    const second=await api('/bots',legacyScript,201);
    legacyDraft=await api('/bots/'+second.id+'/'+second.revision+'/verify',{});
    assert.equal(legacyDraft.ok,true);
  }
  await host.close();
  host=await open(current);
  if (legacyDraft) {
    const versions=(await api('/workspace')).bots.filter(row=>row.id===legacyScript.id);
    assert.equal(versions[0].status,'enabled');
    assert.equal(versions[0].sampleReady,true);
    assert.equal(versions[1].status,'draft');
    assert.equal(versions[1].sampleReady,legacyDraft.workbenchRevision===configModule.WB_REVISION);
    if (!versions[1].sampleReady) {
      assert.equal((await api('/bots/'+legacyScript.id+'/'+versions[1].revision+'/publish',{},409)).code,'sample_required');
    }
  }

  const available=(await api('/workspace')).drivers;
  const flow=available.find(row=>row.id==='dsh-web').workflows.find(row=>row.id===baseFlow);
  assert.equal(flow.sourceRevision,configModule.WB_REVISION);
  assert.match(flow.digest,/^[a-f0-9]{64}$/);
  assert.ok(!Object.hasOwn(flow,'instructions')&&available.filter(row=>row.workflows.length).length===1);
  assert.equal((await api('/bots',form,422)).code,'workflow_required');
  assert.equal((await api('/bots',{...form,kind:'brief',driver:'hermes'},422)).code,'workflow_required');
  for (const input of [
    {...form,workflow:'unknown-method'},
    {...form,driver:'dsh',workflow:baseFlow},
    {...form,kind:'brief',workflow:baseFlow},
    {...form,skills:['talking-script'],workflow:baseFlow}
  ]) assert.equal((await api('/bots',input,422)).code,'workflow_scope');
  check('只有声明的 Harness 与成果类型可选自带流程，拒绝空方法、错误流程、跨适配器与混搭');

  if (ui) await composeWithBrowser();
  else await api('/bots',{...form,workflow:baseFlow},201);
  const draft=await bot(form.id);
  assert.equal(draft.status,'draft');
  assert.deepEqual(draft.skills,[]);
  assert.deepEqual(draft.workflow,flow);
  assert.equal((await api(action('publish'),{},409)).code,'sample_required');

  const prior=model.calls.length;
  await appendFile(reference,'\n合成失配测试。\n','utf8');
  try {
    const invalid=await api(action('verify'),{});
    assert.equal(invalid.ok,false);
    assert.equal(invalid.code,'workflow_source');
    assert.equal(model.calls.length,prior);
    assert.equal((await api(action('publish'),{},409)).code,'sample_required');
  } finally {
    await writeFile(reference,original);
  }
  check('原件不符时保留候选及失败原因，模型请求数不增加');

  const {estimateScriptTiming}=await import(pathToFileURL(path.join(root,'server','workbench-workflow.mjs')));
  const originalChecker=await readFile(checker);
  await appendFile(checker,'\n# 合成校验器失配\n','utf8');
  try {
    await assert.rejects(estimateScriptTiming(host.config,[{start:0,end:6,spoken:spokenFixture}]),
      {code:'script_timing_unavailable'});
  } finally {
    await writeFile(checker,originalChecker);
  }

  const projects=await api('/projects');
  malformed=true;
  let rejected;
  try {
    rejected=await api(action('verify'),{});
  } finally {
    malformed=false;
  }
  assert.equal(rejected.ok,false);
  assert.equal(rejected.code,'workbench_transport');
  assert.equal((await api(action('publish'),{},409)).code,'sample_required');
  assert.equal((await api(action('sample-preview'),undefined,404)).code,'sample_preview_unavailable');
  await assert.rejects(access(path.join(options.data,'runtime',rejected.runId)),{code:'ENOENT'});
  assert.deepEqual(await api('/projects'),projects);
  assert.equal(model.calls.length,prior+1);
  check('通过本机结构校验但无法由真实工作台保存的样例保持候选，临时项目已清理');

  reviewSample=true;
  if (ui) {
    const card=page.locator('.manage-card').filter({has:page.getByRole('heading',{name:form.name+' r1',exact:true})});
    await card.getByRole('button',{name:'验证样例'}).click();
    await card.getByText(/样例已通过.*工作台回读成功/).waitFor({timeout:60000});
    await page.setViewportSize({width:320,height:720});
    await card.getByRole('button',{name:'查看样例成果'}).click();
    const review=page.getByRole('dialog',{name:'样例预览'});
    await review.getByRole('region',{name:'已通过工作台保存与回读的样例'}).waitFor();
    await review.getByText('工作台回读成功',{exact:true}).waitFor();
    await review.getByRole('region',{name:'口播时长核对'}).waitFor();
    await review.locator('.shot-evidence-review').getByText(sampleClaim,{exact:true}).waitFor();
    assert.ok(await review.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await shot('窄屏-口播样例回读');
    await review.getByRole('button',{name:'关闭样例预览'}).click();
    await review.waitFor({state:'hidden'});
    await page.setViewportSize({width:1440,height:900});
    await card.getByRole('button',{name:'启用此版'}).click();
    await card.getByRole('button',{name:'停用此版'}).waitFor();
    await shot('桌面-工作台流程已启用');
  } else {
    assert.equal((await api(action('verify'),{})).ok,true);
    await api(action('publish'),{});
  }
  reviewSample=false;
  const enabled=await bot(form.id);
  assert.equal(enabled.status,'enabled');
  assert.deepEqual(enabled.sample.workflow,flow);
  assert.equal(enabled.sample.workbenchRevision,configModule.WB_REVISION);
  const sampleView=await api(action('sample-preview'));
  assert.equal(sampleView.timing.method,'workbench-script-check');
  assert.equal(sampleView.timing.revision,configModule.WB_REVISION);
  assert.equal(enabled.sample.evidenceReviewShots,1);
  assert.deepEqual(sampleView.evidenceReview,[{index:1,statements:[{text:sampleClaim,fields:['subtitle'],kinds:['number','cause']}]}]);
  assert.deepEqual(await api('/projects'),projects);
  await assert.rejects(access(path.join(options.data,'runtime',enabled.sample.runId)),{code:'ENOENT'});
  assert.equal(model.calls.length,prior+2);
  assert.equal(observedMethods.at(-1),true);
  check('固定版工作台说明进入样例请求，独立项目保存并回读，回执绑定流程指纹，通过后启用');

  let id;
  dense=true;
  if (ui) {
    await page.goto(host.origin+'/#bots');
    const entry=page.locator('.directory-card').filter({has:page.getByRole('heading',{name:form.name,exact:true})});
    await entry.getByRole('button',{name:'新建会话'}).click();
    await page.getByRole('button',{name:'载入书店演练'}).click();
    await page.waitForURL(url=>url.hash.startsWith('#chat/'));
    id=new URL(page.url()).hash.slice(6).split('?')[0];
    await page.getByRole('button',{name:'发送消息'}).click();
  } else {
    id=await createRoom(form.id);
    const view=await room(id);
    await api('/rooms/'+id+'/runs',runInput(view.draft),202);
  }
  const pending=await waitRun(id,'waiting_approval');
  dense=false;
  assert.equal(pending.view.artifacts.length,0);
  const {approval}=pending.run;
  const timing=pending.run.previewTiming;
  assert.deepEqual(timing.rates,[240,300]);
  assert.deepEqual(timing.shots[0],{characters:120,fastSeconds:24,slowSeconds:30,fitsSlow:false});
  assert.equal(pending.run.preview.segments[1].start,7);
  await assert.rejects(access(path.join(options.data,'workbench','projects',approval.project,'calculations')),{code:'ENOENT'});
  if (ui) {
    const card=page.getByRole('region',{name:'本轮写入审批'});
    await card.getByText(/1 镜的排期短于慢速估算/).waitFor();
    await card.getByRole('button',{name:/核对分镜 · 拟写入内容/}).click();
    const preview=page.getByLabel('会话预览');
    await preview.getByRole('region',{name:'口播时长核对'}).waitFor();
    await preview.getByText('口播估算 24–30 秒 · 120 字').waitFor();
    await shot('桌面-口播时长审批');
    await page.setViewportSize({width:320,height:720});
    await card.getByRole('button',{name:/核对分镜 · 拟写入内容/}).click();
    const drawer=page.getByRole('dialog',{name:'会话预览'});
    await drawer.getByRole('region',{name:'口播时长核对'}).waitFor();
    assert.ok(await drawer.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await shot('窄屏-口播时长核对');
    await drawer.getByRole('button',{name:'关闭预览'}).click();
    await drawer.waitFor({state:'hidden'});
    await card.getByRole('button',{name:'允许本次写入'}).click();
  } else {
    await api('/runs/'+pending.run.id+'/decide',{id:approval.id,digest:approval.digest,allow:true},202);
  }
  const done=await waitRun(id,'succeeded',pending.run.id);
  const [artifact]=done.view.artifacts;
  assert.equal(artifact.version,1);
  assert.equal(artifact.result.segments.length,4);
  assert.deepEqual(artifact.timing,timing);
  assert.ok(artifact.receipt?.id);
  const context=await host.app.workbench.context(artifact.receipt.project);
  assert.equal(context.heads.script,artifact.receipt.id);
  const saved=context.artifacts.find(row=>row.id===artifact.receipt.id);
  assert.equal(saved.payload.segments[1].start,7);
  assert.ok(saved.payload.production_limits.includes('第 1 镜的排期短于慢速估算。'));
  const exported=await api('/artifacts/'+artifact.id+'/export');
  assert.deepEqual(exported.manifest.timing,timing);
  assert.match(exported.markdown,/第 1 镜的排期短于慢速估算/);
  const events=await api('/runs/'+done.run.id+'/events');
  assert.deepEqual(events.find(row=>row.kind==='accepted').data.workflow,flow);
  assert.equal(model.calls.length,prior+3);
  assert.equal(observedMethods.at(-1),true);
  check('逐镜核对时长并显示超排期镜次，保留停顿间隔，审批后在工作台与导出中可回读');

  const send=runInput({attachments:pending.run.materialIds},'请在同一项目核对脚本。');
  const beforeFailure=model.calls.length;
  await appendFile(reference,'\n合成运行失配。\n','utf8');
  try {
    const before=await api('/rooms/'+id);
    const refused=await api('/rooms/'+id+'/runs',send,503);
    assert.equal(refused.code,'workbench_unavailable');
    assert.match(refused.error,/版本核对/);
    const after=await api('/rooms/'+id);
    assert.equal(after.artifacts.length,1);
    assert.deepEqual(after.runs,before.runs);
    assert.deepEqual(after.draft,before.draft);
    assert.equal(model.calls.length,beforeFailure);
  } finally {
    await writeFile(reference,original);
    assert.equal((await api('/dependencies',{})).checks.workbench.ok,true);
  }
  check('已验证流程在受理前重新核对原件，拒绝改动后的内容且保留旧稿');

  host.app.store.change(state=>{
    state.bots.find(row=>row.id===form.id).workflow.digest='f'.repeat(64);
  });
  try {
    const changed=await bot(form.id);
    assert.equal(changed.workflowChanged,true);
    assert.equal(changed.sampleReady,false);
    await api('/rooms/'+id+'/runs',{...send,clientRequestId:randomUUID()},503);
    assert.equal(model.calls.length,beforeFailure);
  } finally {
    host.app.store.change(state=>{state.bots.find(row=>row.id===form.id).workflow.digest=flow.digest;});
  }
  check('工作区绑定的流程指纹变化时阻止新任务且历史仍可读');

  if (legacyRoom) {
    const view=await room(legacyRoom);
    const oldRun=await api('/rooms/'+legacyRoom+'/runs',runInput(view.draft),202);
    const result=await waitRun(legacyRoom,'succeeded',oldRun.id);
    assert.equal(result.view.artifacts.length,1);
    assert.equal(observedMethods.at(-1),false);
  }
  const leftover=path.join(options.data,'runtime',rejected.runId,'workbench');
  await mkdir(leftover,{recursive:true});
  await writeFile(path.join(leftover,'合成清理夹具.txt'),'合成的未清理副本。','utf8');
  host.app.store.change(state=>{
    state.verifications.find(row=>row.id===rejected.runId).cleanupPending=true;
  });
  await browser?.close();browser=null;
  await host.close();host=await open(old);
  const previousView=await room(id);
  assert.equal(previousView.artifacts[0].receipt.id,artifact.receipt.id);
  const originalExport=await api('/artifacts/'+artifact.id+'/export');
  assert.ok(originalExport.markdown.includes(artifact.receipt.id));
  if (!previousHasFlow) {
    const denied=await api('/rooms/'+id+'/runs',{...send,clientRequestId:randomUUID()},409);
    assert.equal(denied.code,'sample_required');
  }
  await host.close();host=await open(current);
  await assert.rejects(access(leftover),{code:'ENOENT'});
  assert.deepEqual((await bot(form.id)).workflow,flow);
  assert.equal((await bot(form.id)).sample.workbenchRevision,configModule.WB_REVISION);
  assert.equal((await room(id)).artifacts[0].receipt.id,artifact.receipt.id);
  assert.deepEqual((await room(id)).artifacts[0].timing,timing);
  check('回滚仍可读和导出原成果，再升级恢复流程绑定；保留旧版已验证通用规则');

  assert.ok(model.calls.every(call=>call.tools===0));
  assert.equal(observedMethods.filter(Boolean).length,3);
  const report={version,previousVersion,previousHasFlow,legacyGenerates:!!legacyRoom,checks,
    ui:{viewports:ui?widths:[],animationMs:ui?180:null,reducedMotion:ui},workflow:flow,
    verification:{runId:enabled.sample.runId,assemblyDigest:enabled.sample.assemblyDigest,
      workbenchRevision:enabled.sample.workbenchRevision,evidenceReview:sampleView.evidenceReview,
      rejected:{runId:rejected.runId,code:rejected.code},
      oldVersion:{publishedStillReady:!!legacyPublished,candidateHadReadBack:!!legacyDraft?.workbenchRevision},reopenedCleanup:true},
    timing:{checked:timing,sample:sampleView.timing,checkerMismatchRejected:true,retainedTimelineGap:true},
    script:{id:artifact.id,receipt:artifact.receipt},provider:{fixture:true,requests:model.calls.length,workflowRequests:3,paidRequests:0}};
  if (reportPath) await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  try {await browser?.close();}
  finally {
    try {await host?.close();}
    finally {await model.close();}
  }
}

