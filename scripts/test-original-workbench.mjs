import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';
import { readWindow } from '../test/native-api.mjs';
import { startFixtureWorkbench } from '../test/isolated-workbench.mjs';

const appRoot=resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{configFor,processEnvironment},{Workbench},{Problem,sha},{makeSamples}]=await Promise.all(
  ['http','config','workbench','contracts','registry'].map(name=>import(pathToFileURL(join(appRoot,'server',name+'.mjs')))));
const {unzipSync,strFromU8}=createRequire(join(appRoot,'package.json'))('fflate');
const data=await mkdtemp(join(tmpdir(),'hb-original-'));
const originalWorkbenchState=join(data,'独立工作台');
const originalWorkbenchData=join(originalWorkbenchState,'原项目');
const hyperBotData=join(data,'Hyper Bot');
const scriptMarker='工作台独立创建的初稿试验';
const unselected='ORIGINAL_EXCLUDED_SOURCE_42';
let approvedDraftSource;
const model=await modelFixture({observe:({text,sources})=>{
  assert.ok(!text.includes(unselected));
  if (text.includes('带入已选原稿')) {
    assert.ok(text.includes(scriptMarker));
    assert.equal(sources.length,3);
  }
  if (text.includes('从待审稿调整结尾')) {
    const textBase=text.split('\n\n授权续改的来源版本：\n')[1]?.split('\n\n授权材料（只读）：\n')[0];
    assert.deepEqual(JSON.parse(textBase),approvedDraftSource);
  }
}});
const options={data:hyperBotData,originalWorkbenchState,originalWorkbenchData,
  providerKey:'hyper-bot-test',upstream:model.origin};
const config=await configFor(options);
const checks=[];
function pass(value) { checks.push(value); console.log('OK '+value); }

let failOn,host,service,manifest,project;
const processes=[];
class TestWorkbench extends Workbench {
  constructor(config) {
    super(config);
    const request=this.original.request.bind(this.original);
    this.original.request=async (client,method,route,body,signal)=>{
      const result=await request(client,method,route,body,signal);
      if (method==='POST'&&failOn&&route.endsWith(failOn)) {
        failOn=null;
        throw new Problem(503,'夹具在原工作台写入后断开。','workbench_transport');
      }
      return result;
    };
  }
}
const open=()=>launch({options,workbenchFactory:config=>new TestWorkbench(config)});

async function request(origin,route,body,status) {
  const response=await fetch(origin+route,body===undefined?{}:{
    method:'POST',headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},body:JSON.stringify(body)});
  const result=await response.json();
  if (status) assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}
const api=(route,body,status)=>request(host.origin,'/api'+route,body,status);
const upstream=(route,body)=>request(service.base_url,'/api'+route,body);
const original=(suffix,body)=>upstream('/agent/v1/projects/'+project+suffix,body);
const context=()=>original('/context');
const room=id=>api('/rooms/'+id);
const start=(id,text,attachments,originalBase)=>api('/rooms/'+id+'/runs',{
  text,attachments,...(originalBase?{originalBase}:{}),clientRequestId:randomUUID(),authorized:true});
const approve=(run,allow=true)=>api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow});
const recover=run=>api('/runs/'+run.id+'/recover',{});
const add=(id,name,content)=>api('/rooms/'+id+'/materials',{name,content,authorized:true}).then(row=>row.id);
const importFile=(id,source,authorized=true)=>api('/rooms/'+id+'/original/materials',{
  source:source.id,digest:source.digest,authorized},authorized?201:422).then(row=>row.id);

async function stage(roomId,runId,expected) {
  const deadline=Date.now()+45000;
  while (Date.now()<deadline) {
    const current=await room(roomId);
    const run=current.runs.find(row=>row.id===runId);
    if (run?.state===expected) return {current,run};
    if (run && ['failed','interrupted','cancelled','succeeded'].includes(run.state)) {
      throw new Error(expected+' expected, '+run.state+' received: '+run.error);
    }
    await sleep(220);
  }
  throw new Error('Timed out waiting for '+expected);
}

async function addUpstream(label,content) {
  const fresh=await context();
  const response=await original('/sources',{revision:fresh.project.revision,label,content,nature:'simulation',origin:'独立工作台夹具'});
  return response.source;
}

async function startWorkbench(state,projects) {
  const fixture=await startFixtureWorkbench({appRoot,config,processEnvironment,state,projects});
  processes.push(fixture);
  return fixture;
}

async function seedOriginal() {
  const started=await startWorkbench(originalWorkbenchState,originalWorkbenchData);
  manifest=started.locator;
  service=started.registration;
  const first=await upstream('/projects',{title:'书店开门前 · 独立工作台',simulation:true});
  const other=await upstream('/projects',{title:'另一个合成演练项目',simulation:true});
  project=first.id;
  const [interview,notes]=makeSamples();
  const source=await addUpstream(interview.name,interview.content);
  await addUpstream('未选用项目素材.txt',unselected);
  const ctx=await context();
  const seed=await original('/artifacts',{
    request_id:randomUUID(),stage:'script',revision:ctx.project.revision,context_id:ctx.context_id,
    input_artifact_ids:[],standalone_reason:'演练已给定口播方向',declared_status:'needs_review',
    unresolved:[],supersedes:null,revision_reason:null,
    payload:{topic_artifact_id:null,topic_id:null,cta:'',production_limits:[],
      claims:[{id:'c1',kind:'observation',text:scriptMarker,limitation:'合成项目夹具',
        evidence:[{source_id:source.id,quote:'我每天先把门口那排书摆好，再开灯。'}]}],
      segments:[{id:'s1',start:0,end:5,spoken:scriptMarker,visual:'书店大门',subtitle:'开门',claim_ids:['c1']}]}
  });
  assert.equal(seed.accepted,true);
  return {first,other,source,notes,old:seed.artifact};
}

async function selectProject(page) {
  await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'自媒体口播',exact:true})})
    .getByRole('button',{name:'新建会话'}).click();
  const dialog=page.getByRole('dialog',{name:'新建自媒体口播会话'});
  await dialog.getByRole('button',{name:'连接独立工作台'}).click();
  await dialog.locator('optgroup[label="独立 Self Media Workbench"] option').first().waitFor({state:'attached'});
  await dialog.getByLabel('工作台项目').selectOption('original:'+manifestChoice.storage+':'+project);
  return dialog;
}

async function projectMaterialDialog(page,source) {
  await page.getByRole('tab',{name:/^材料/}).click();
  await page.getByRole('button',{name:'从原项目选用'}).click();
  const dialog=page.getByRole('dialog',{name:'原工作台项目'});
  await dialog.getByRole('button',{name:'选用 '+source.label}).waitFor();
  return dialog;
}

async function browserCheck(seed) {
  const playwright=process.env.HYPER_BOT_TEST_PLAYWRIGHT;
  if(!playwright)return;
  const {chromium}=createRequire(import.meta.url)(playwright);
  const browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const screenshots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots,{recursive:true});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.origin+'/#bots');
    const create=await selectProject(page);
    if(screenshots) await page.screenshot({path:join(screenshots,'桌面-连接独立工作台.png'),animations:'disabled'});
    await create.getByRole('button',{name:'开始会话'}).click();
    await page.locator('.composer').waitFor();
    const hash=new URL(page.url()).hash;
    assert.match(hash,/^#chat\/[a-f0-9-]+/);
    const session=hash.slice('#chat/'.length);
    if (!(await page.getByRole('tab',{name:/^材料/}).isVisible())) {
      await page.getByRole('button',{name:'查看材料'}).click();
    }
    const dialog=await projectMaterialDialog(page,seed.source);
    assert.equal(await dialog.evaluate(el=>getComputedStyle(el).animationDuration),'0.24s');
    if(screenshots) await page.screenshot({path:join(screenshots,'桌面-原项目素材.png'),animations:'disabled'});
    await dialog.getByRole('button',{name:'选用 '+seed.source.label}).click();
    await dialog.getByText('已选用',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'带入原稿'}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByText('续改原项目当前稿',{exact:true}).waitFor();
    const view=await room(session);
    assert.equal(view.project,project);
    assert.equal(view.original.storage,manifestChoice.storage);
    const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.goto(host.origin+'/#chat/'+session);
    await mobile.getByRole('button',{name:'预览',exact:true}).click();
    const narrow=await projectMaterialDialog(mobile,seed.source);
    const rect=await narrow.boundingBox();
    assert.ok(rect.x>=0&&rect.x+rect.width<=390&&rect.y>=0&&rect.y+rect.height<=844);
    assert.equal(await narrow.evaluate(el=>getComputedStyle(el).animationName),'none');
    await mobile.keyboard.press('Escape');
    await narrow.waitFor({state:'hidden'});
    await mobile.locator('#right-preview').waitFor();
    assert.deepEqual(errors,[]);
    pass('真实浏览器从 Bot 目录绑定原项目、逐份选材、带入原稿，核对桌面 240 ms 和手机减少动效');
  } finally {
    await browser.close();
  }
}

async function desktopCheck(seed) {
  const executablePath=process.env.HYPER_BOT_TEST_DESKTOP;
  if (!executablePath) return;
  const {_electron}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT||'playwright');
  const env={...process.env,DEEPSEEK_API_KEY:'isolated-ui-fixture',HYPER_BOT_DATA_DIR:join(data,'桌面工作区'),
    HYPER_BOT_WORKBENCH_ROOT:config.workbenchRoot,HYPER_BOT_WORKBENCH_PYTHON:config.workbenchPython,
    SELF_MEDIA_STATE_DIR:originalWorkbenchState,SELF_MEDIA_DATA_DIR:originalWorkbenchData};
  delete env.HYPER_BOT_NODE_RUNTIME;
  const app=await _electron.launch({executablePath,env,timeout:35000});
  try {
    const originalState=await context();
    const page=await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
    await page.goto(new URL(page.url()).origin+'/#bots');
    const select=await selectProject(page);
    await select.getByRole('button',{name:'开始会话'}).click();
    await page.locator('.composer').waitFor();
    const dialog=await projectMaterialDialog(page,seed.source);
    await dialog.getByRole('button',{name:'选用 '+seed.source.label}).click();
    await dialog.getByText('已选用',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'带入原稿'}).click();
    await page.getByText('续改原项目当前稿',{exact:true}).waitFor();
    const data=await readWindow(page,'/api/rooms/'+new URL(page.url()).hash.slice(6));
    assert.equal(data.project,project);
    assert.equal(data.original.storage,manifestChoice.storage);
    assert.equal((await context()).context_id,originalState.context_id);
    pass('解压的 Windows 桌面程序通过登记服务识别并绑定独立原项目，选材阶段未写入');
  } finally {
    await app.close();
  }
}

let manifestChoice;
try {
  const seed=await seedOriginal();
  const originalFile=join(originalWorkbenchData,project,'agent','artifacts',seed.old.id+'.json');
  const earlierContents=await readFile(originalFile);
  host=await open();
  const choices=await api('/projects/original');
  manifestChoice=choices.find(row=>row.id===project);
  assert.equal(choices.length,2);
  assert.equal(manifestChoice.title,seed.first.title);
  assert.deepEqual(await api('/projects'),[]);
  const selection={botId:'media',revision:1,title:'独立项目的续改会话',project,projectScope:'original',
    simulation:true,projectStorage:manifestChoice.storage};
  const refusedStore=await api('/rooms',{...selection,projectStorage:'0'.repeat(64)},409);
  assert.equal(refusedStore.code,'workbench_identity');
  await api('/rooms',{...selection,project:randomUUID().replaceAll('-','')},404);
  await browserCheck(seed);
  await desktopCheck(seed);
  const {id}=await api('/rooms',selection);
  const loaded=await api('/rooms/'+id+'/original');
  assert.deepEqual(loaded.sources.map(file=>file.name),[seed.source.label,'未选用项目素材.txt']);
  assert.ok(loaded.sources.every(file=>!('content' in file)));
  assert.equal(loaded.latest.id,seed.old.id);
  assert.deepEqual(loaded.latest.sourceIds,[seed.source.id]);
  const selected=loaded.sources.find(file=>file.id===seed.source.id);
  await importFile(id,selected,false);
  const other=(await api('/rooms',{...selection,project:seed.other.id})).id;
  await api('/rooms/'+other+'/original/materials',{source:selected.id,digest:selected.digest,authorized:true},409);
  await api('/rooms/'+id+'/original/materials',{source:selected.id,digest:'0'.repeat(64),authorized:true},409);
  const copied=await importFile(id,selected);
  assert.equal(await importFile(id,selected),copied);
  const provided=await add(id,seed.notes.name,seed.notes.content.replaceAll('\n','\r\n'));
  const unused=await add(id,'备用拍摄记录.txt','第三份已选用材料，夹具生成的分镜不引用。');
  const files=[copied,provided,unused];
  const firstContext=await context();
  const missing=await start(id,'原稿续改没有选择原文的情况。',[provided,unused],seed.old.id);
  const rejected=await stage(id,missing.id,'failed');
  assert.match(rejected.run.error,/原稿引用的项目材料/);
  assert.equal(model.calls.length,0);
  pass('独立目录识别、项目归属、原素材摘要与续稿选材约束通过');

  const first=await start(id,'带入已选原稿，生成可读的口播分镜。',files,seed.old.id);
  const pending=await stage(id,first.id,'waiting_approval');
  assert.equal(pending.run.approval.project,project);
  assert.equal(pending.run.approval.supersedes,seed.old.id);
  assert.equal(pending.run.approval.review.version,1);
  assert.equal(pending.run.approval.review.sourceVersion,null);
  assert.ok(pending.run.approval.review.changes.shots.length>0);
  assert.deepEqual(pending.run.approval.sourceNames,[seed.notes.name]);
  assert.equal((await context()).context_id,firstContext.context_id);
  approvedDraftSource=pending.run.preview;
  const returnBody={id:pending.run.approval.id,digest:pending.run.approval.digest,draftToken:pending.current.draftToken};
  assert.equal((await api('/runs/'+first.id+'/revise',returnBody,202)).decision,'editing');
  await stage(id,first.id,'cancelled');
  assert.equal((await context()).context_id,firstContext.context_id);
  const draft=(await room(id)).draft;
  assert.equal(draft.proposalBase,first.id);
  const fromDraft=await api('/rooms/'+id+'/runs',{...draft,text:'从待审稿调整结尾。',clientRequestId:randomUUID(),authorized:true},202);
  const revised=await stage(id,fromDraft.id,'waiting_approval');
  assert.equal(revised.run.originalBase,seed.old.id);
  assert.equal(revised.run.approval.supersedes,seed.old.id);
  await approve(revised.run,false);
  await stage(id,fromDraft.id,'cancelled');
  assert.equal((await context()).context_id,firstContext.context_id);
  pass('独立工作台的原稿可带入待审稿再改，打开、选材、退回、再生成和拒绝审批均无写入');

  const deniedRace=await start(id,'模拟保存前另一位编辑更新项目。',files,seed.old.id);
  const raced=await stage(id,deniedRace.id,'waiting_approval');
  await addUpstream('其他编辑的记录.txt','另一个编辑器提交的合成拍摄说明。');
  const changed=await context();
  await approve(raced.run);
  const race=await stage(id,deniedRace.id,'failed');
  assert.match(race.run.error,/变化/);
  assert.equal(race.run.unwrittenDraft,true);
  assert.equal(race.run.approval.status,'revoked');
  assert.equal((await context()).context_id,changed.context_id);
  const scope={id:raced.run.approval.id,digest:raced.run.approval.digest};
  await api('/runs/'+deniedRace.id+'/revise',{...scope,draftToken:race.current.draftToken},202);
  const restored=await room(id);
  assert.deepEqual(restored.draftProposal.result,raced.run.preview);
  const resent=await api('/rooms/'+id+'/runs',{...restored.draft,text:'按变更后的原项目继续审阅。',
    clientRequestId:randomUUID(),authorized:true},202);
  const updated=await stage(id,resent.id,'waiting_approval');
  assert.equal(updated.run.originalBase,undefined);
  assert.equal(updated.run.approval.revision,changed.project.revision);
  await approve(updated.run,false);
  await stage(id,resent.id,'cancelled');
  assert.equal((await context()).context_id,changed.context_id);
  pass('独立工作台变更时确认零写入，带回分镜后按当前修订生成新审批');

  const partial=await start(id,'带入已选原稿并登记所引用的新材料。',files,seed.old.id);
  const partialProposal=await stage(id,partial.id,'waiting_approval');
  failOn='/sources';
  await approve(partialProposal.run);
  const partialResult=await stage(id,partial.id,'interrupted');
  assert.equal(partialResult.run.unwrittenDraft,undefined);
  assert.equal(partialResult.run.recovery,'required');
  const interruptedApproval={id:partialProposal.run.approval.id,digest:partialProposal.run.approval.digest};
  await api('/runs/'+partial.id+'/revise',{...interruptedApproval,draftToken:partialResult.current.draftToken},409);
  const afterPartial=await context();
  assert.equal(afterPartial.heads.script,seed.old.id);
  assert.equal(afterPartial.tasks.length,0);
  assert.equal(afterPartial.sources.length,changed.sources.length+1);
  await api('/rooms/'+id+'/runs',{text:'重复保存',attachments:files,clientRequestId:randomUUID(),authorized:true},409);
  await host.close(); host=await open();
  assert.deepEqual(await recover(partial),{found:false,checked:true,registered:1});
  const check=(await api('/recoveries')).rows.find(item=>item.id===partial.id);
  assert.equal(check.state,'not_saved');
  assert.equal(check.registered,1);
  assert.equal(check.artifact,null);
  assert.ok(check.checkedAt);
  assert.equal((await context()).context_id,afterPartial.context_id);
  const cleared=await room(id);
  await api('/runs/'+partial.id+'/revise',{...interruptedApproval,draftToken:cleared.draftToken},202);
  assert.deepEqual((await room(id)).draftProposal.result,partialProposal.run.preview);
  assert.equal((await context()).context_id,afterPartial.context_id);
  pass('材料登记后断线须先只读核对，确认分镜未保存后可带回同一稿件');

  const commit=await start(id,'带入已选原稿，保存同一项目的新分镜。',files,seed.old.id);
  const commitProposal=await stage(id,commit.id,'waiting_approval');
  assert.deepEqual(commitProposal.run.approval.sourceNames,[]);
  failOn='/artifacts';
  await approve(commitProposal.run);
  const unknown=await stage(id,commit.id,'interrupted');
  assert.equal(unknown.run.recovery,'required');
  assert.equal(unknown.current.artifacts.length,0);
  const written=await context();
  assert.equal(written.sources.length,afterPartial.sources.length);
  assert.equal(written.tasks.length,1);
  assert.equal(written.tasks[0].request.session_key,'hyper-bot:'+id);
  assert.equal(written.artifacts.length,2);
  const artifact=written.artifacts.find(item=>item.id===written.heads.script);
  assert.equal(artifact.supersedes,seed.old.id);
  const localSource=written.sources.find(file=>file.origin==='hyper-bot:material:'+provided);
  assert.equal(localSource.sha256,sha(seed.notes.content));
  assert.equal(written.sources.some(file=>file.origin==='hyper-bot:material:'+unused),false);
  assert.deepEqual(new Set(artifact.payload.claims.flatMap(claim=>claim.evidence.map(link=>link.source_id))),
    new Set([selected.id,localSource.id]));
  assert.deepEqual(await readFile(originalFile),earlierContents);
  await host.close(); host=await open();
  assert.deepEqual(await recover(commit),{found:true});
  assert.equal((await room(id)).artifacts[0].receipt.id,artifact.id);
  assert.equal((await context()).context_id,written.context_id);
  pass('实际分镜写入后回执断线，重启核对回读同一版本，复用材料，旧稿文件逐字节保留');

  await api('/bots/media/1/disable',{});
  const url=host.origin+'/api/bots/media/1/history-export';
  const headers={'X-Hyper-Bot':'1'};
  const exported=await fetch(url,{headers});
  assert.equal(exported.status,200);
  const entries=unzipSync(new Uint8Array(await exported.arrayBuffer()));
  const delivered=JSON.parse(strFromU8(entries['版本与来源.json'])).versions.find(item=>item.workbench.id===artifact.id);
  assert.equal(delivered.conversationId,id);
  assert.equal(delivered.workbench.project,project);
  assert.equal(delivered.workbench.supersedes,seed.old.id);
  assert.ok(strFromU8(entries[delivered.file]).includes(artifact.id));
  assert.ok(!Object.values(entries).some(bytes=>strFromU8(bytes).includes(unselected)));
  assert.equal((await context()).context_id,written.context_id);
  pass('停用后的历史 ZIP 可带走独立工作台产物与回执，原项目修订和未选材料均得到保留');

  await api('/rooms/'+id+'/materials/'+copied+'/revoke',{confirmed:true},202);
  await api('/rooms/'+id+'/materials/'+copied,undefined,410);
  const revoked=await room(id);
  assert.equal(revoked.artifacts[0].endedAt!=null,true);
  await api('/artifacts/'+revoked.artifacts[0].id+'/export',undefined,410);
  assert.equal((await fetch(url,{headers})).status,410);
  await api('/bots/media/1/restore',{});
  assert.equal((await context()).context_id,written.context_id);
  assert.equal((await upstream('/projects')).length,2);
  assert.deepEqual(await api('/projects'),[]);
  const unapproved=await start(id,'已撤回原材料后尝试再次带入已保存稿件。',[provided,unused],artifact.id);
  assert.match((await stage(id,unapproved.id,'failed')).run.error,/原稿引用的项目材料/);
  assert.ok(model.calls.every(call=>call.tools===0&&call.materialCount===3));
  pass('撤回清理会话内容和导出授权，外部项目与稿件保留，续改须重新授权来源');

  const alternate=join(data,'另一个独立工作台');
  const alternateData=join(alternate,'原项目');
  await cp(join(originalWorkbenchData,project),join(alternateData,project),{recursive:true});
  const swapped=await startWorkbench(alternate,alternateData);
  try {
    await writeFile(manifest,JSON.stringify(swapped.registration));
    const displaced=await api('/rooms/'+id+'/original',undefined,409);
    assert.equal(displaced.code,'workbench_identity');
  } finally {
    await writeFile(manifest,JSON.stringify(service));
  }
  assert.equal((await context()).context_id,written.context_id);
  pass('注册服务换到持有相同项目编号的另一个数据目录时，会话拒绝接入');

  const report={mode:'独立 Workbench 实例和 DSH Web Host，本机模型响应夹具',checks,
    fixture:{project,original:seed.old.id,saved:artifact.id,source:localSource.id,modelCalls:model.calls.length}};
  if(process.env.HYPER_BOT_TEST_REPORT) {
    await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify(report,null,2));
} finally {
  await host?.close();
  await model.close();
  for (const server of processes) server.close();
}

