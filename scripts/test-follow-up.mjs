import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture, sample } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const {launch}=await import(pathToFileURL(join(root,'server','http.mjs')));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const data=await mkdtemp(join(tmpdir(),'hb-follow-up-'));
const shots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const revision='把第二镜改短一点。';
const briefRevision='只加一条需要确认的素材问题。';
const updatedLine='门口第一排先摆齐。';
const untouchedText='下一个任务先保留这条人工草稿。';
const observations=[];
const model=await modelFixture({
  observe({text,sources}){
    const from=text.split('\n\n授权续改的来源版本：\n')[1]?.split('\n\n授权材料（只读）：\n')[0];
    observations.push({source:from?JSON.parse(from):null,materials:sources.map(source=>source.id)});
  },
  respond(prompt){
    const result=sample(prompt);
    if(prompt.text.includes(revision))result.segments[1].spoken=updatedLine;
    if(prompt.text.includes(briefRevision))result.notes.push('现场声的授权范围待确认。');
    return result;
  }
});
const checks=[];
const pass=label=>{checks.push(label);console.log('OK '+label);};
const errors=[];
const measurements=[];
let host,browser,finishSave;

async function request(route,body,status=200) {
  const options=body===undefined?{}:{method:'POST',headers:{
    'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(host.origin+'/api'+route,{...options,signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  assert.equal(response.status,status,JSON.stringify(result));
  return result;
}
async function until(read,test) {
  const timeout=AbortSignal.timeout(60000);
  for (;;) {
    const value=await read();
    if(test(value))return value;
    await delay(110,null,{signal:timeout});
  }
}
function awaitRun(room,index,desired) {
  return until(room,state=>{
    const run=state.runs[index];
    if(run?.state===desired)return true;
    if(['failed','cancelled','interrupted','succeeded'].includes(run?.state)){
      throw new Error('Expected '+desired+', got '+run.state+': '+run.error);
    }
    return false;
  });
}
const input=page=>page.locator('#message');
const anchor=(page,n)=>page.getByRole('button',{name:'继续修改 v'+n,exact:true});
const approve=page=>page.getByRole('button',{name:'允许本次写入',exact:true});
const clear=page=>page.getByRole('button',{name:'清除源版本',exact:true});
const newTask=page=>page.getByRole('button',{name:'另起任务',exact:true});
const rawDraft=id=>host.app.store.read().conversations.find(room=>room.id===id).draft;
const empty={text:'',attachments:[],base:null};
const focus=async (page,control)=>{
  const target=await control.elementHandle();
  try {await page.waitForFunction(el=>el===document.activeElement,target,{timeout:3500});}
  finally {await target.dispose();}
};

async function example(page,bot) {
  await page.goto(host.origin+'/#bots');
  await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:bot,exact:true})})
    .getByRole('button',{name:'新建会话',exact:true}).click();
  await page.getByRole('button',{name:'载入书店演练',exact:true}).click();
  await page.waitForURL(/#chat\/[-a-f0-9]+$/);
  const id=page.url().split('#chat/')[1];
  await input(page).waitFor();
  return {id,room:()=>request('/rooms/'+id)};
}
async function capture(page,name) {
  if(!shots)return;
  await mkdir(shots,{recursive:true});
  await page.screenshot({path:join(shots,name+'.png'),animations:'disabled'});
}
async function newPage(options) {
  const page=await browser.newPage(options);
  page.on('pageerror',error=>errors.push(error.message));
  return page;
}

try {
  host=await launch({options:{data,upstream:model.origin,providerKey:'fixture'}});
  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const desk=await newPage({viewport:{width:1440,height:900}});
  const {id,room}=await example(desk,'自媒体口播');
  await input(desk).press('Enter');
  const queued=await awaitRun(room,0,'waiting_approval');
  assert.deepEqual(queued.draft,empty);
  assert.equal(queued.artifacts.length,0);
  await approve(desk).click();
  const first=await awaitRun(room,0,'succeeded');
  const v1=first.artifacts[0];
  assert.deepEqual(first.draft,{text:'',attachments:v1.materialIds,base:v1.id});
  assert.deepEqual(rawDraft(id),empty);
  assert.equal(first.suggestedBase,v1.id);
  assert.equal(first.draftToken,queued.draftToken);
  assert.ok(v1.receipt.id);
  assert.equal(Object.hasOwn(first.runs[0],'followUpDraftStamp'),false);
  pass('只有确认已保存的成果才进入下一轮输入区，显示来源时无草稿写入和额外模型调用');

  for(const [width,height] of [[1440,900],[1024,900],[768,900],[390,844],[320,780]]){
    const mobile=width<=390,reduced=width===320;
    const page=await newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile,
      reducedMotion:reduced?'reduce':'no-preference'});
    await page.goto(desk.url());
    const source=anchor(page,1);
    await source.waitFor();
    assert.equal(await input(page).getAttribute('aria-describedby'),'draft-source-version');
    assert.equal(await input(page).getAttribute('placeholder'),'说说这一版要怎么改…');
    assert.equal(await page.locator('.composer-files > span').count(),v1.materialIds.length);
    const bounds=await source.boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width && bounds.y>=0 && bounds.y+bounds.height<=height);
    if(mobile)assert.ok(bounds.height>=44 && (await newTask(page).boundingBox()).height>=44);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    assert.equal(await page.locator('.source-selection').evaluate(el=>getComputedStyle(el).animationName),reduced?'none':'status-in');
    if(!reduced)assert.equal(await page.locator('.source-selection').evaluate(el=>getComputedStyle(el).animationDuration),'0.18s');
    if(width===1440||width===390) await capture(page,(mobile?'手机':'桌面')+'-会话续改来源');
    if(mobile){
      await source.press('Enter');
      await page.getByRole('heading',{name:v1.result.title,exact:true}).waitFor();
      await page.getByRole('button',{name:'关闭预览',exact:true}).click();
      await page.locator('#right-preview').waitFor({state:'hidden'});
      await focus(page,source);
    }
    measurements.push({width,sourceAnimationMs:reduced?0:180,mobilePreviewFocus:mobile?true:null});
    await page.close();
  }
  pass('五种窗口宽度显示源版本和原文，窄屏可从输入区打开稿件并返回原焦点');

  await desk.reload();
  await anchor(desk,1).waitFor();
  await input(desk).fill(revision);
  await input(desk).press('Enter');
  const next=await awaitRun(room,1,'waiting_approval');
  assert.equal(next.runs[1].base,v1.id);
  assert.deepEqual(next.runs[1].materialIds,v1.materialIds);
  assert.equal(next.runs[1].approval.review.sourceVersion,1);
  assert.equal(next.runs[1].approval.review.version,2);
  assert.deepEqual(observations[1],{source:v1.result,materials:v1.materialIds});
  await desk.getByText('拟保存 v2',{exact:true}).waitFor();
  await capture(desk,'桌面-续改写入审批');
  await approve(desk).click();
  const revised=await awaitRun(room,1,'succeeded');
  const v2=revised.artifacts[1];
  assert.equal(v2.base,v1.id);
  assert.equal(v2.receipt.project,v1.receipt.project);
  assert.notEqual(v2.receipt.id,v1.receipt.id);
  assert.deepEqual(v2.result.segments.map((shot,index)=>index===1?{...shot,spoken:v1.result.segments[1].spoken}:shot),v1.result.segments);
  assert.equal(v2.result.segments[1].spoken,updatedLine);
  assert.deepEqual(revised.artifacts[0].result,v1.result);
  assert.equal(revised.draft.base,v2.id);
  pass('在原会话发出一条普通消息即可改第二镜，原项目审批新增 v2 并保留 v1');

  await newTask(desk).click();
  await focus(desk,input(desk));
  const reset=await until(room,state=>!state.draft.base);
  assert.notEqual(reset.draftToken,revised.draftToken);
  assert.deepEqual(reset.draft,empty);
  assert.equal(reset.suggestedBase,undefined);
  await desk.reload();
  await input(desk).waitFor();
  assert.equal(await anchor(desk,2).count(),0);
  assert.equal(await input(desk).getAttribute('placeholder'),'给自媒体口播发消息…');
  await desk.getByRole('tab',{name:/^版本/}).click();
  await desk.getByRole('button',{name:'继续改稿',exact:true}).click();
  await anchor(desk,2).waitFor();
  await clear(desk).click();
  await focus(desk,input(desk));
  const independent=await until(room,state=>!state.draft.base&&state.draft.attachments.length===v2.materialIds.length);
  assert.deepEqual(independent.draft.attachments,v2.materialIds);
  pass('另起任务可一键清除默认来源和带入的材料，刷新后保持空白。手动续改时清除版本保留自己的选材');

  const editing=await example(desk,'自媒体口播');
  assert.equal(await anchor(desk,2).count(),0);
  await input(desk).press('Enter');
  const pending=await awaitRun(editing.room,0,'waiting_approval');
  const release=new Promise(resolve=>{finishSave=resolve;});
  let acknowledge;
  const saving=new Promise(resolve=>{acknowledge=resolve;});
  await desk.route('**/api/rooms/'+editing.id+'/draft',async route=>{
    acknowledge();
    await release;
    await route.continue();
  },{times:1});
  await input(desk).fill(untouchedText);
  await saving;
  await approve(desk).click();
  const result=await awaitRun(editing.room,0,'succeeded');
  assert.equal(result.draftToken,pending.draftToken);
  assert.equal(await input(desk).inputValue(),untouchedText);
  assert.equal(await anchor(desk,1).count(),0);
  finishSave();
  const kept=await until(editing.room,state=>state.draft.text===untouchedText);
  assert.equal(kept.draft.base,null);
  assert.deepEqual(kept.draft.attachments,[]);
  await desk.reload();
  await input(desk).waitFor();
  assert.equal(await input(desk).inputValue(),untouchedText);
  assert.equal(await anchor(desk,1).count(),0);
  pass('上一轮完成时若下一段消息正在保存，保留人工草稿且不改变它的材料或来源');

  const brief=await example(desk,'素材简报');
  await input(desk).press('Enter');
  const b1=await awaitRun(brief.room,0,'succeeded');
  assert.equal(b1.runs[0].driver,'hermes');
  await anchor(desk,1).waitFor();
  await input(desk).fill(briefRevision);
  await input(desk).press('Enter');
  const b2=await awaitRun(brief.room,1,'succeeded');
  assert.equal(b2.artifacts[1].base,b1.artifacts[0].id);
  assert.ok(b2.artifacts[1].result.notes.includes('现场声的授权范围待确认。'));
  assert.deepEqual(observations[4].source,b1.artifacts[0].result);
  assert.equal(b2.draft.base,b2.artifacts[1].id);
  pass('素材简报的普通续问沿用其自身的上一版和两份已授权原文，Hermes 保存下一版');

  const removed=b2.draft.attachments[0];
  await request('/rooms/'+brief.id+'/materials/'+removed+'/revoke',{confirmed:true},202);
  const revoked=await until(brief.room,state=>state.artifacts.every(item=>item.endedAt));
  assert.deepEqual(revoked.draft,empty);
  assert.equal(await request('/rooms/'+brief.id+'/materials/'+removed,undefined,410).then(row=>row.code),'material_ended');
  assert.equal(model.calls.length,5);
  assert.ok(model.calls.every(call=>call.tools===0));
  assert.deepEqual(errors,[]);
  pass('撤回材料后立即停止提供默认续改来源，相关稿件按当前授权处理');

  let rollback;
  const previousRoot=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  if(previousRoot) {
    const current=await room();
    const fields={text:'下一轮继续保留现有开场。',attachments:v2.materialIds,base:v2.id};
    await request('/rooms/'+id+'/draft',{...fields,draftToken:current.draftToken});
    await browser.close();
    browser=null;
    await host.close();
    const {launch:previousLaunch}=await import(pathToFileURL(join(previousRoot,'server','http.mjs')));
    host=await previousLaunch({options:{data,upstream:model.origin,providerKey:'fixture'}});
    const reopened=await room();
    assert.deepEqual(reopened.draft,fields);
    assert.deepEqual(reopened.artifacts.map(item=>item.receipt.id),[v1.receipt.id,v2.receipt.id]);
    assert.equal(reopened.artifacts[1].base,v1.id);
    assert.equal(model.calls.length,5);
    const previous=JSON.parse(await readFile(join(previousRoot,'package.json'),'utf8')).version;
    rollback={version:previous,sourceAndDraftRetained:true,versions:reopened.artifacts.map(item=>item.version)};
    pass('回滚后可查看原项目两版成果，已编辑的续改草稿连同来源及原文保留');
  }

  const report={version,checks,viewports:measurements,providerRequests:model.calls.length,paidRequests:0,
    ...(rollback?{rollback}:{}),
    script:{firstVersion:v1.version,secondVersion:v2.version,sameProject:true,separateWorkbenchReceipts:true},
    brief:{versions:b2.artifacts.map(item=>item.version),driver:'hermes'}};
  if(process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  finishSave?.();
  await browser?.close();
  await host?.close();
  await model.close();
}
