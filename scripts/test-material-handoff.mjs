import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';
import { startFixtureWorkbench } from '../test/isolated-workbench.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT??fileURLToPath(new URL('../',import.meta.url)));
const fromApp=(app,name)=>import(pathToFileURL(join(app,'server',name+'.mjs')));
const [{launch},{backupWorkspace,restoreWorkspace},{processEnvironment}]=await Promise.all(
  ['http','workspace-archive','config'].map(name=>fromApp(root,name)));
const {chromium}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const work=await mkdtemp(join(tmpdir(),'hb-material-handoff-'));
const data=join(work,'workspace');
const marker='HB_SELECTED_'+randomUUID(), excluded='HB_UNSELECTED_'+randomUUID();
const prompts=[];
const model=await modelFixture({observe:input=>prompts.push(input)});
const options={data,upstream:model.origin,providerKey:'handoff-fixture',
  originalWorkbenchState:join(work,'original'),originalWorkbenchData:join(work,'original','projects')};
const headers={'Content-Type':'application/json','X-Hyper-Bot':'1'};
const screenshots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const checks=[];
let host,browser,external;
const pass=line=>{checks.push(line);console.log('OK '+line);};

async function request(origin,route,body,status) {
  const response=await fetch(origin+route,{
    ...(body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  if (status) assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,JSON.stringify(result));
  return result;
}
const api=(route,body,status)=>request(host.origin,'/api'+route,body,status);
const room=id=>api('/rooms/'+id);
const source=(roomId,id)=>'/rooms/'+roomId+'/materials/'+id;
const add=(roomId,name,content)=>api('/rooms/'+roomId+'/materials',{name,content,authorized:true},201).then(x=>x.id);
const exportVersion=(id,status)=>api('/artifacts/'+id+'/export',undefined,status);

async function until(read,ready) {
  const signal=AbortSignal.timeout(50000);
  for (;;) {
    const value=await read();
    if (ready(value)) return value;
    await delay(150,null,{signal});
  }
}

async function phase(roomId,runId,expected) {
  return until(()=>room(roomId),snapshot=>{
    const run=snapshot.runs.find(item=>item.id===runId);
    if (run.state===expected) return true;
    if (['succeeded','failed','interrupted','cancelled'].includes(run.state)) {
      throw new Error('Expected '+expected+', received '+run.state+' '+run.error);
    }
    return false;
  });
}

const send=(roomId,text,attachments)=>api('/rooms/'+roomId+'/runs',{
  text,attachments,authorized:true,clientRequestId:randomUUID()},202);
const decide=(run,status=202)=>api('/runs/'+run.id+'/decide',{id:run.approval.id,digest:run.approval.digest,allow:true},status);
async function script(roomId,text,attachments,waitForApproval=false) {
  const accepted=await send(roomId,text,attachments);
  const room=await phase(roomId,accepted.id,'waiting_approval');
  const pending=room.runs.find(item=>item.id===accepted.id);
  if (waitForApproval) return pending;
  await decide(pending);
  const saved=await phase(roomId,accepted.id,'succeeded');
  return saved.artifacts.find(item=>item.run===accepted.id);
}

async function publish(id,name,kind,driver,skill) {
  const draft=await api('/bots',{id,name,kind,driver,skills:[skill],description:'按已有授权材料处理同一专项任务。'},201);
  assert.equal(draft.revision,2);
  assert.equal((await api('/bots/'+id+'/2/verify',{})).ok,true);
  await api('/bots/'+id+'/2/publish',{});
}

const handoff=(botId,from,materials,extra={})=>({botId,revision:2,title:'跨版续接演练',
  handoff:{from,materials,authorized:true,requestId:randomUUID()},...extra});

async function capture(page,name) {
  if (!screenshots) return;
  await mkdir(screenshots,{recursive:true});
  await page.screenshot({path:join(screenshots,name+'.png'),animations:'disabled'});
}

async function checkDialog(page,opener,name,measurements) {
  const width=page.viewportSize().width;
  await opener.click();
  const dialog=page.getByRole('dialog',{name:'切换版本续接'});
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'授权并新建会话'}).isEnabled(),false);
  const measure=await dialog.evaluate(node=>{
    const box=node.getBoundingClientRect(),style=getComputedStyle(node),focused=document.activeElement;
    return {width:innerWidth,left:box.left,right:box.right,overflow:node.scrollWidth-node.clientWidth,
      rootOverflow:document.documentElement.scrollWidth-innerWidth,animation:style.animationDuration,
      focus:focused?.tagName,controls:[...node.querySelectorAll('.modal-head button,.handoff-files label,.modal-actions button')]
        .map(item=>Math.round(item.getBoundingClientRect().height))};
  });
  assert.ok(measure.left>=0&&measure.right<=width+0.5&&measure.overflow<=1&&measure.rootOverflow<=1,JSON.stringify(measure));
  assert.equal(measure.focus,'INPUT');
  assert.equal(measure.animation,width===320?'0s':'0.24s');
  assert.ok(measure.controls.every(value=>value>=44),JSON.stringify(measure));
  measurements.push(measure);
  if (name) {
    await dialog.getByRole('textbox',{name:'新会话标题'}).fill('书店开门前 · 新版口播');
    await dialog.getByRole('checkbox',{name:/已选访谈/}).check();
    await dialog.getByRole('checkbox',{name:/现场动作/}).check();
    await capture(page,name);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  assert.ok(await opener.evaluate(node=>document.activeElement===node));
}

try {
  host=await launch({options});
  external=await startFixtureWorkbench({appRoot:root,config:host.config,processEnvironment,
    state:options.originalWorkbenchState,projects:options.originalWorkbenchData});
  const workbench=(route,body)=>request(external.registration.base_url,'/api'+route,body);
  const ownProject=await workbench('/projects',{title:'独立项目续接夹具',simulation:true});
  const picked=(await api('/projects/original')).find(item=>item.id===ownProject.id);
  const originalRoom=(await api('/rooms',{botId:'media',revision:1,title:'独立工作台旧会话',simulation:true,
    project:picked.id,projectScope:'original',projectStorage:picked.storage},201)).id;
  const originalFiles=[await add(originalRoom,'原项目补充访谈.md','这是明确选中的旧会话访谈。'),
    await add(originalRoom,'原项目拍摄笔记.txt','只写发生过的动作。')];

  const old=(await api('/rooms',{botId:'media',revision:1,title:'书店开门前的旧会话',simulation:true},201)).id;
  const one=await add(old,'已选访谈.md','我每天先把门口那排书摆好，再开灯。\n'+marker);
  const two=await add(old,'现场动作.txt','把钥匙挂回门边后再开灯。');
  const three=await add(old,'未选材料.txt',excluded);
  const files=[one,two];
  const v1=await script(old,'按授权材料整理首版分镜。',files);
  const oldBrief=(await api('/rooms',{botId:'brief',revision:1,title:'旧版 Hermes 素材简报',simulation:true},201)).id;
  const notes=[await add(oldBrief,'简报原文.md','先在值班表上写明来源。'),
    await add(oldBrief,'复核记录.txt','遇到不同说法，应将两条分别列出。')];
  const briefRun=await send(oldBrief,'请归纳这两份记录的主要分歧或缺项。',notes);
  await phase(oldBrief,briefRun.id,'succeeded');

  await publish('media','自媒体口播','script','dsh','talking-script');
  await publish('brief','素材简报','brief','dsh-web','material-brief');
  const forbidden=handoff('media',old,files);
  assert.equal((await api('/rooms',{...forbidden,revision:1},409)).error,'这个 Bot 版本还未启用。');
  assert.equal((await api('/rooms',{...forbidden,handoff:{...forbidden.handoff,authorized:false}},422)).code,'validation');
  assert.equal((await api('/rooms',handoff('brief',old,files),403)).code,'handoff_scope');
  assert.equal((await api('/rooms',handoff('media',old,[one,notes[0]]),403)).code,'material_scope');
  assert.equal((await api('/rooms',handoff('media',old,files,{simulation:true}),422)).code,'handoff_scope');
  const stranger=(await api('/rooms',{botId:'media',revision:2,title:'独立新会话',simulation:true},201)).id;
  assert.equal((await api(source(stranger,one),undefined,403)).code,'material_scope');
  assert.equal((await api('/rooms',handoff('media',stranger,files),403)).code,'handoff_scope');
  await host.close();host=null;
  const pre=join(work,'before-handoff');
  await backupWorkspace(data,pre);
  host=await launch({options});
  pass('确认授权、同 Bot 不同版本和来源会话权限均由服务端校验');

  browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin+'/#chat/'+old);
  const opener=page.getByRole('button',{name:'切换版本续接'});
  const measurements=[];
  for (const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:width>=768?900:760});
    await page.emulateMedia({reducedMotion:width===320?'reduce':'no-preference'});
    await checkDialog(page,opener,width===1440?'桌面-跨版续接':width===390?'手机-跨版续接':null,measurements);
  }
  await page.setViewportSize({width:1440,height:900});
  await opener.click();
  const dialog=page.getByRole('dialog',{name:'切换版本续接'});
  await dialog.getByRole('textbox',{name:'新会话标题'}).fill('新版继续书店口播');
  await dialog.getByRole('checkbox',{name:/已选访谈/}).check();
  await dialog.getByRole('checkbox',{name:/现场动作/}).check();
  const posted=page.waitForResponse(response=>response.url()===host.origin+'/api/rooms'&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'授权并新建会话'}).click();
  const response=await posted;
  assert.equal(response.status(),201,await response.text());
  const {id:next}=await response.json();
  const nextHeading=page.getByRole('heading',{name:'新版继续书店口播'});
  await nextHeading.waitFor();
  assert.ok(await nextHeading.evaluate(node=>document.activeElement===node));
  assert.equal(await page.getByRole('link',{name:'来自 r1 会话'}).getAttribute('href'),'#chat/'+old);
  const sent=response.request().postDataJSON();
  assert.equal((await api('/rooms',sent,201)).id,next);
  assert.equal((await api('/rooms',{...sent,title:'不匹配的续接请求'},409)).code,'duplicate_request');
  assert.deepEqual((await room(next)).draft.attachments,files);
  assert.deepEqual((await room(next)).materials.map(file=>file.id),files);
  assert.equal((await room(next)).simulation,true);
  assert.equal((await room(next)).project,v1.project);
  assert.equal((await api(source(next,three),undefined,403)).code,'material_scope');
  await capture(page,'桌面-续接后会话');
  assert.deepEqual(errors,[]);
  pass('五种视口均可逐份选择材料和取消，续接在新会话保留所选材料及来源，同编号重送不重复新建');

  const beforeModel=prompts.length;
  const v2=await script(next,'请按选中的资料继续本项目口播。',files);
  assert.equal(v2.receipt.project,v1.receipt.project);
  assert.equal(v2.receipt.supersedes,v1.receipt.id);
  assert.equal(v2.previous,v1.id);
  assert.equal(v2.version,2);
  assert.deepEqual(prompts.slice(beforeModel).map(item=>item.sources.map(file=>file.id)),[files]);
  assert.ok(prompts.every(item=>!item.text.includes(excluded)));
  const exported=await exportVersion(v2.id);
  assert.deepEqual(exported.manifest.sources.map(file=>file.originConversationId),[old,old]);
  assert.equal((await room(old)).artifacts[0].result.title,v1.result.title);
  const groups=await api('/library');
  const group=groups.find(row=>row.versions.some(item=>item.id===v2.id));
  assert.deepEqual((await api('/library/'+group.id)).files.map(file=>file.id),files);
  await page.reload();
  await page.getByRole('heading',{name:v2.result.title,exact:true}).waitFor();
  await capture(page,'桌面-续接后分镜');
  pass('换 DSH 通道后在同一托管 Workbench 项目保存 v2，来源和版本链可回查，未选材料未进入模型');

  const originalState=await room(originalRoom);
  const continuedOriginal=(await api('/rooms',handoff('media',originalRoom,originalFiles),201)).id;
  const linked=await room(continuedOriginal);
  assert.deepEqual(linked.original,originalState.original);
  const originalV1=await script(continuedOriginal,'用已选材料在独立原项目拟写一版稿。',originalFiles);
  assert.equal(originalV1.receipt.project,ownProject.id);
  const currentUpstream=()=>workbench('/agent/v1/projects/'+ownProject.id+'/context');
  assert.equal((await currentUpstream()).heads.script,originalV1.receipt.id);
  await api(source(originalRoom,originalFiles[0])+'/revoke',{confirmed:true},202);
  assert.equal((await exportVersion(originalV1.id,410)).code,'material_ended');
  assert.equal((await currentUpstream()).heads.script,originalV1.receipt.id);
  pass('续接独立 Self Media Workbench 项目沿用原存储身份，跨会话撤回只清理 Hyper Bot 可控副本');

  const continuedBrief=(await api('/rooms',handoff('brief',oldBrief,notes),201)).id;
  const r2BriefRun=await send(continuedBrief,'核对两份简报原文的分歧或缺项。',notes);
  const nextBrief=await phase(continuedBrief,r2BriefRun.id,'succeeded');
  assert.equal(nextBrief.runs[0].driver,'dsh-web');
  assert.equal((await room(oldBrief)).runs[0].driver,'hermes');
  const ends=new Date(Date.now()+4800).toISOString();
  await api(source(continuedBrief,notes[0])+'/deadline',{expiresAt:ends});
  assert.equal((await api(source(oldBrief,notes[0]))).expiresAt,ends);
  await until(()=>room(oldBrief),x=>x.materials.find(f=>f.id===notes[0]).reason==='expired');
  const expired=await room(continuedBrief);
  assert.equal(expired.artifacts[0].result,undefined);
  assert.equal((await api('/rooms',handoff('brief',oldBrief,notes),410)).code,'material_ended');
  pass('同一简报 Bot 从 Hermes 切至 DSH Web Host，改到期时间及清理同时作用于两版会话');

  await host.close();host=null;
  const after=join(work,'after-handoff');
  await backupWorkspace(data,after);
  const restored=join(work,'reopened');
  await restoreWorkspace(after,restored);
  const previous=process.env.HYPER_BOT_TEST_PREVIOUS_APP_ROOT;
  if (previous) {
    const previousApp=await fromApp(previous,'http');
    await assert.rejects(previousApp.launch({options:{...options,data:restored}}),/hyper_bot_linked_materials/);
    const before=join(work,'rollback');
    await restoreWorkspace(pre,before);
    host=await previousApp.launch({options:{...options,data:before}});
    assert.equal((await exportVersion(v1.id)).manifest.id,v1.id);
    assert.equal((await room(old)).materials.length,3);
    await host.close();host=null;
    pass('旧版拒绝打开已建立共享授权的工作区，可用续接前备份回滚并读取旧稿');
  }
  host=await launch({options:{...options,data:restored}});
  assert.equal((await room(next)).continuedFrom.id,old);
  assert.equal((await exportVersion(v2.id)).manifest.id,v2.id);
  const pending=await script(next,'为原项目再写一版，等待确认。',files,true);
  for(const id of [old,next])await api('/rooms/'+id+'/draft',{text:'待清理 '+marker,attachments:files});
  await api(source(old,one)+'/revoke',{confirmed:true},202);
  assert.equal((await decide(pending,409)).code,'approval_scope');
  for (const [roomId,artifact] of [[old,v1],[next,v2]]) {
    const view=await until(()=>room(roomId),x=>x.materials.find(file=>file.id===one).cleanup==='complete');
    assert.equal(view.draft.text,'');
    assert.ok(!view.draft.attachments.includes(one));
    assert.ok(view.runs.every(run=>!run.prompt.includes(marker)));
    assert.equal((await api(source(roomId,one),undefined,410)).code,'material_ended');
    assert.equal((await exportVersion(artifact.id,410)).code,'material_ended');
  }
  assert.equal((await api(source(old,three))).content,excluded);
  const projectDir=join(restored,'workbench','projects',v1.project,'agent','sources');
  for(const name of await readdir(projectDir)) {
    assert.ok(!(await readFile(join(projectDir,name),'utf8')).includes(marker));
  }
  assert.equal((await room(next)).runs.find(run=>run.id===pending.id).state,'cancelled');
  assert.equal((await room(next)).artifacts.length,1);
  pass('备份恢复保留共享范围，随后撤回会清理两边的原文、草稿和稿件并作废尚未批准的写入');

  const result={version,mode:'真实 DSH Web Host、DSH SDK、Hermes ACP 和 Self Media Workbench，合成模型协议夹具',
    checks,layout:measurements,stored:{managed:{project:v1.project,previous:v1.id,current:v2.id},
      original:{project:originalV1.receipt.project,artifact:originalV1.receipt.id},brief:{from:oldBrief,to:continuedBrief}},
    modelRequests:model.calls.length};
  if (process.env.HYPER_BOT_TEST_REPORT) await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await host?.close();
  external?.close();
  await model.close();
}
