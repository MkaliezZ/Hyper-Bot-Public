import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture, sample } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const previous=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
assert.ok(previous,'请提供上一版解压件的 resources/app。');
const app=path=>import(pathToFileURL(join(path,'server/http.mjs')));
const version=path=>readFile(join(path,'package.json'),'utf8').then(JSON.parse).then(pkg=>pkg.version);
const [current,old,appVersion,priorVersion]=await Promise.all([app(root),app(previous),version(root),version(previous)]);
const data=await mkdtemp(join(tmpdir(),'hb-approval-revision-'));
const localInput='把第一镜改短，只保留店主把书摆齐的动作。';
const finalInput=localInput+' 其他镜头保持原样。';
const spokenClaim='我们亲测了30次，因为在门口摆两排书，进店人数提高了80%';
const subtitleClaim='因为开灯，转化率提升了50%';
const needsReview=[
  {index:0,statements:[{text:spokenClaim,fields:['spoken'],kinds:['number','experience','cause']}]},
  {index:1,statements:[{text:subtitleClaim,fields:['subtitle'],kinds:['number','cause']}]}
];
const seen=[];
const model=await modelFixture({
  respond(input) {
    const source=input.text.split('\n\n授权续改的来源版本：\n')[1]?.split('\n\n授权材料（只读）：\n')[0];
    const base=source?JSON.parse(source):null;
    seen.push({base,materials:input.sources.map(file=>file.id)});
    assert.match(input.text,/口播词和字幕里的比例、销量等数字/);
    if (!input.text.includes(localInput)) {
      const output=sample(input);
      const [first,second,third]=output.segments;
      first.spoken=spokenClaim+'。';
      second.subtitle=subtitleClaim+'。';
      third.spoken='店主说：“'+first.evidence[0].quote+'”';
      third.evidence=[{...first.evidence[0],quote:third.spoken}];
      return output;
    }
    assert.ok(base?.segments?.length);
    const [first,...rest]=base.segments;
    return {...base,segments:[{...first,spoken:'我把门口那排书摆齐。'},...rest]};
  }
});
const options={data,providerKey:'approval-revision-fixture',upstream:model.origin};
const open=module=>module.launch({options});
const checks=[];
const pass=label=>{checks.push(label);console.log('OK '+label);};
const pictures=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const report=process.env.HYPER_BOT_TEST_REPORT;
let host,browser,page;

async function api(route,body,status=200) {
  const headers={'X-Hyper-Bot':'1','Content-Type':'application/json'};
  const options=body===undefined?{headers}:{headers,method:'POST',body:JSON.stringify(body)};
  const res=await fetch(host.origin+'/api'+route,{...options,signal:AbortSignal.timeout(45000)});
  const out=await res.json();
  assert.equal(res.status,status,JSON.stringify(out));
  return out;
}
const room=id=>api('/rooms/'+id);
const proof=run=>({id:run.approval.id,digest:run.approval.digest});
const decision=(run,allow,status=202)=>api('/runs/'+run.id+'/decide',{...proof(run),allow},status);
const change=(run,draftToken,status=202)=>api('/runs/'+run.id+'/revise',{...proof(run),draftToken},status);
const send=(id,draft,status=202)=>api('/rooms/'+id+'/runs',{...draft,clientRequestId:randomUUID(),authorized:true},status);
async function until(read,accept) {
  const signal=AbortSignal.timeout(35000);
  for (;;) {
    const value=await read();
    if (accept(value)) return value;
    await wait(130,null,{signal});
  }
}
async function phase(id,runId,wanted) {
  const view=await until(()=>room(id),result=>{
    const run=result.runs.find(row=>row.id===runId);
    if (run?.state===wanted) return true;
    if (run&&['succeeded','failed','cancelled','interrupted'].includes(run.state)) throw new Error(run.error??run.state);
    return false;
  });
  return {view,run:view.runs.find(row=>row.id===runId)};
}
async function pending(title) {
  const {id}=await api('/rooms',{botId:'media',revision:1,title,example:true},201);
  const {draft}=await room(id);
  const run=await send(id,draft);
  return {id,...await phase(id,run.id,'waiting_approval')};
}
async function image(name) {
  if (!pictures) return;
  await mkdir(pictures,{recursive:true});
  await page.screenshot({path:join(pictures,name+'.png'),animations:'disabled'});
}
const input=()=>page.getByRole('textbox',{name:'给自媒体口播发消息'});
const revisionSource=()=>page.getByRole('button',{name:'查看待改分镜'});

try {
  host=await open(current);
  const first=await pending('书店口播审改');
  assert.deepEqual(first.run.previewEvidenceReview,needsReview);
  const oldToken=first.view.draftToken;
  await api('/rooms/'+first.id+'/draft',{...first.view.draft,text:localInput,draftToken:oldToken});
  assert.equal((await change(first.run,oldToken,409)).code,'draft_conflict');
  const edited=await room(first.id);
  assert.equal(edited.runs[0].state,'waiting_approval');
  assert.equal(edited.draft.text,localInput);
  pass('旧标签页的草稿令牌不能替换较新的修改要求，原审批仍待处理');

  if (!process.argv.includes('--no-ui')) {
    const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
    browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM??undefined});
    page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(host.origin+'/#chat/'+first.id);
    const edit=page.getByRole('button',{name:'先改这版'});
    await edit.waitFor();
    const approval=page.getByRole('region',{name:'本轮写入审批'});
    await approval.getByText('2 镜有表述待核对原文。').waitFor();
    await approval.getByRole('button',{name:/核对分镜 · 拟写入内容/}).press('Enter');
    const preview=page.getByLabel('会话预览');
    await preview.locator('.shot-evidence-review').getByText(spokenClaim,{exact:true}).waitFor();
    await preview.locator('.shot-evidence-review').getByText('口播 · 数字、亲历、因果').waitFor();
    await preview.locator('.shot.open .evidence button').click();
    await preview.getByText('原文预览',{exact:true}).waitFor();
    await preview.getByRole('button',{name:'返回第 1 镜'}).click();
    await preview.locator('.shot-evidence-review').getByText(spokenClaim,{exact:true}).waitFor();
    await image('桌面-待审稿操作');
    await page.setViewportSize({width:320,height:720});
    assert.ok(await page.locator('.approval-actions').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.setViewportSize({width:1440,height:900});
    await input().fill(finalInput);
    await edit.press('Enter');
    await revisionSource().waitFor();
    assert.equal(await input().inputValue(),finalInput);
    await page.waitForFunction(()=>document.activeElement?.id==='message');
    assert.equal(await page.locator('.source-selection').evaluate(node=>getComputedStyle(node).animationDuration),'0.18s');
    await image('桌面-待审稿带回输入框');
    await page.setViewportSize({width:320,height:720});
    await page.emulateMedia({reducedMotion:'reduce'});
    await revisionSource().press('Enter');
    const panel=page.getByRole('dialog',{name:'会话预览'});
    await panel.getByText('待改稿',{exact:true}).waitFor();
    const nextShot=panel.getByRole('button',{name:/摆书.*依据待核对/});
    await nextShot.press('Enter');
    const statement=panel.locator('.shot-evidence-review').getByText(subtitleClaim,{exact:true});
    await statement.waitFor();
    await statement.scrollIntoViewIfNeeded();
    assert.equal(await panel.getByRole('group',{name:'导出'}).count(),0);
    assert.ok(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    assert.ok(await nextShot.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await image('窄屏-待改分镜');
    await panel.getByRole('button',{name:'关闭预览'}).click();
    await panel.waitFor({state:'hidden'});
    assert.equal(await page.locator('.source-selection').evaluate(node=>getComputedStyle(node).animationName),'none');
  } else {
    const newer=await api('/rooms/'+first.id+'/draft',{...edited.draft,text:finalInput,draftToken:edited.draftToken});
    assert.equal((await change(first.run,newer.draftToken)).decision,'editing');
  }
  const returned=await room(first.id);
  assert.equal(returned.runs[0].state,'cancelled');
  assert.equal(returned.runs[0].approval.status,'revoked');
  assert.equal(returned.runs[0].preview,undefined);
  assert.deepEqual(returned.draft.attachments,first.run.materialIds);
  assert.equal(returned.draft.text,finalInput);
  assert.equal(returned.draft.proposalBase,first.run.id);
  assert.deepEqual(returned.draftProposal.result,first.run.preview);
  assert.deepEqual(returned.draftProposal.timing,first.run.previewTiming);
  assert.deepEqual(returned.draftProposal.evidenceReview,needsReview);
  assert.equal((await change(first.run,edited.draftToken)).decision,'editing');
  const events=await api('/runs/'+first.run.id+'/events');
  assert.equal(events.filter(event=>event.kind==='approval'&&event.data.decision==='returned').length,1);
  assert.equal((await decision(first.run,true,409)).code,'approval_scope');
  assert.equal((await host.app.workbench.context(first.run.approval.project)).artifacts.length,0);
  assert.equal(model.calls.length,1);
  pass('退回和重放只撤销一次原审批，带回同一稿件、材料和两镜依据提示，原项目没有产生脚本');

  const {id:other}=await api('/rooms',{botId:'media',revision:1,title:'隔离会话',example:true},201);
  const otherDraft=(await room(other)).draft;
  assert.equal((await send(other,{...otherDraft,proposalBase:first.run.id},403)).code,'proposal_scope');
  assert.equal((await send(first.id,{...returned.draft,attachments:[returned.draft.attachments[0]]},403)).code,'material_scope');
  assert.equal(model.calls.length,1);
  pass('跨会话引用和漏选待审稿的授权材料均在模型请求前被拒绝');

  await host.close();host=await open(old);
  const legacy=await room(first.id);
  assert.equal(legacy.draft.text,finalInput);
  assert.equal(legacy.draft.proposalBase,legacy.draftProposal?.id);
  if (legacy.draftProposal) assert.deepEqual(legacy.draftProposal.result,first.run.preview);
  assert.equal((await decision(first.run,true,409)).code,'approval_scope');
  await host.close();host=await open(current);
  const restored=await room(first.id);
  assert.equal(restored.draft.text,finalInput);
  assert.deepEqual(restored.draftProposal.result,first.run.preview);
  assert.deepEqual(restored.draftProposal.evidenceReview,needsReview);
  assert.equal(restored.draft.proposalBase,first.run.id);
  pass('切回旧版能读取草稿和终态，重启新版找回待改来源，旧审批仍失效');

  if (page) {
    await page.goto(host.origin+'/#chat/'+first.id);
    await revisionSource().waitFor();
    await page.getByRole('button',{name:'发送消息'}).click();
  } else {
    await send(first.id,restored.draft);
  }
  const queued=await until(()=>room(first.id),value=>value.runs.length===2);
  const next=await phase(first.id,queued.runs[1].id,'waiting_approval');
  assert.deepEqual(seen[1],{base:first.run.preview,materials:first.run.materialIds});
  assert.equal(next.run.proposalBase,first.run.id);
  assert.equal(next.run.approval.project,first.run.approval.project);
  assert.notEqual(next.run.approval.id,first.run.approval.id);
  assert.equal(next.run.approval.review.version,1);
  assert.deepEqual(next.run.approval.review.changes.shots,[{index:0,fields:['spoken']}]);
  assert.deepEqual(next.run.preview.segments.slice(1),first.run.preview.segments.slice(1));
  assert.deepEqual(next.run.previewEvidenceReview,needsReview.slice(1));
  assert.equal((await api('/runs/'+next.run.id+'/decide',{...proof(first.run),allow:true},409)).code,'approval_scope');
  assert.equal((await host.app.workbench.context(first.run.approval.project)).artifacts.length,0);
  if (page) await page.getByRole('button',{name:'允许本次写入'}).click();
  else await decision(next.run,true);
  const saved=await phase(first.id,next.run.id,'succeeded');
  const [artifact]=saved.view.artifacts;
  assert.equal(artifact.version,1);
  assert.equal(artifact.proposalBase,first.run.id);
  const workspace=await host.app.workbench.context(artifact.receipt.project);
  assert.deepEqual(workspace.artifacts.map(row=>row.id),[artifact.receipt.id]);
  assert.deepEqual(workspace.artifacts[0].payload.claims.map(claim=>claim.kind),
    ['observation','hypothesis','observation','observation']);
  assert.ok(workspace.artifacts[0].unresolved.some(note=>note.includes(subtitleClaim)));
  assert.deepEqual(artifact.evidenceReview,needsReview.slice(1));
  const exportRoute='/artifacts/'+artifact.id+'/export';
  const exported=await api(exportRoute);
  assert.equal(exported.manifest.proposalRunId,first.run.id);
  assert.deepEqual(exported.manifest.evidenceReview,artifact.evidenceReview);
  assert.ok(exported.markdown.includes('第 2 镜字幕 · 数字、因果待核对原文 ｜ '+subtitleClaim));
  const {unzipSync,strFromU8}=createRequire(join(root,'package.json'))('fflate');
  const download=await fetch(host.origin+'/api'+exportRoute+'?format=bundle',{headers:{'X-Hyper-Bot':'1'}});
  const files=unzipSync(new Uint8Array(await download.arrayBuffer()));
  assert.deepEqual(JSON.parse(strFromU8(files['版本与来源.json'])).evidenceReview,artifact.evidenceReview);
  if (page) {
    await page.setViewportSize({width:1440,height:900});
    await page.reload();
    await page.getByLabel('会话预览').locator('.shot-evidence-review').getByText(subtitleClaim,{exact:true}).waitFor();
    await image('桌面-已保存的依据复核');
  }
  pass('改稿后重算依据提示，原项目、重开预览与成果包保留第二镜字幕待核对项');

  const forget=await pending('重启后继续书店分镜');
  const retainedText='再核对第二镜字幕，保留其他镜头。';
  await api('/rooms/'+forget.id+'/draft',{...forget.view.draft,text:retainedText,draftToken:forget.view.draftToken});
  await host.close();host=await open(current);
  const restarted=await room(forget.id);
  const interrupted=restarted.runs.find(run=>run.id===forget.run.id);
  assert.equal(interrupted.state,'interrupted');
  assert.equal(interrupted.approval.status,'revoked');
  assert.equal(interrupted.unwrittenDraft,true);
  await decision(forget.run,true,409);
  if (page) {
    await page.goto(host.origin+'/#chat/'+forget.id);
    await page.getByRole('button',{name:'带回待审分镜'}).press('Enter');
    await revisionSource().waitFor();
    assert.equal(await input().inputValue(),retainedText);
    await page.waitForFunction(()=>document.activeElement?.id==='message');
    const preview=page.getByLabel('会话预览');
    await preview.getByText('待改稿',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'允许本次写入'}).count(),0);
    assert.equal(await preview.getByRole('group',{name:'导出'}).count(),0);
    await image('桌面-重启后带回待审分镜');
    await page.setViewportSize({width:320,height:720});
    const drawer=page.getByRole('dialog',{name:'会话预览'});
    await drawer.waitFor({state:'hidden'});
    await revisionSource().press('Enter');
    await drawer.getByText('待改稿',{exact:true}).waitFor();
    assert.ok(await drawer.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await image('窄屏-重启后待改分镜');
  } else await change(forget.run,restarted.draftToken);
  const editedAfter=await room(forget.id);
  assert.deepEqual(editedAfter.draftProposal.result,forget.run.preview);
  assert.deepEqual(editedAfter.draftProposal.evidenceReview,forget.run.previewEvidenceReview);
  assert.equal(editedAfter.draft.text,retainedText);
  assert.equal(editedAfter.draft.retryOf,forget.run.id);
  assert.equal((await api('/runs/'+forget.run.id+'/events')).filter(event=>event.kind==='proposal_restored').length,1);
  assert.equal((await change(forget.run,restarted.draftToken)).decision,'editing');
  const [removed,retained]=editedAfter.draft.attachments;
  await api('/rooms/'+forget.id+'/draft',{...editedAfter.draft,text:'本地合成修改意见',attachments:[retained],
    draftToken:editedAfter.draftToken});
  await api('/rooms/'+forget.id+'/materials/'+removed+'/revoke',{confirmed:true},202);
  const retired=await until(()=>room(forget.id),value=>value.materials.some(file=>file.id===removed&&file.cleanup==='complete'));
  assert.equal(retired.draftProposal,undefined);
  assert.equal(retired.draft.proposalBase,undefined);
  assert.equal(retired.draft.text,'');
  assert.equal((await send(forget.id,{...retired.draft,text:'尝试带回原稿',proposalBase:forget.run.id},410)).code,'material_ended');
  assert.equal((await host.app.workbench.context(forget.run.approval.project)).artifacts.length,0);
  await host.close();host=await open(old);
  await api('/rooms/'+first.id+'/materials/'+first.run.materialIds[0]+'/revoke',{confirmed:true},202);
  const oldWithdrawn=await room(first.id);
  assert.equal(oldWithdrawn.artifacts[0].evidenceReview,undefined);
  assert.equal(oldWithdrawn.artifacts[0].result,undefined);
  await host.close();host=await open(current);
  const withdrawn=await room(first.id);
  assert.equal(withdrawn.artifacts[0].evidenceReview,undefined);
  assert.equal((await api(exportRoute,undefined,410)).code,'material_ended');
  assert.equal(model.calls.length,3);
  pass('服务重启后可带回待审分镜和已输入的文字，旧批准失效，来源撤回后清除待改稿和预览');

  const result={version:appVersion,previousVersion:priorVersion,checks,scope:'实际 DSH Web Host 与固定版 Workbench，本机模型协议夹具',
    originalRun:first.run.id,revisedRun:next.run.id,receipt:artifact.receipt,visual:!!page,
    evidenceReview:{before:needsReview,after:artifact.evidenceReview,retired:true},
    unwrittenDraft:{restartRetained:true,materialWithdrawalCleared:true,originalApprovalRejected:true},
    modelCalls:model.calls.length,paidRequests:0};
  if (report) await writeFile(report,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await host?.close();
  await model.close();
}
