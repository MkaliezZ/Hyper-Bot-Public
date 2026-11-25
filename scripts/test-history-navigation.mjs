import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';

const root=resolve(process.env.HYPER_BOT_TEST_APP_ROOT ?? fileURLToPath(new URL('../',import.meta.url)));
const [{launch},{libraryView,relatedProjectVersions}]=await Promise.all(['http','history']
  .map(name=>import(pathToFileURL(join(root,'server',name+'.mjs')))));
const {unzipSync,strFromU8}=createRequire(join(root,'package.json'))('fflate');
const archivePath='/bots/media/1/history-export';
const data=await mkdtemp(join(tmpdir(),'hb-history-'));
const hiddenTitle='旧稿授权专名海棠';
const bodyTag='仅在正文出现的测试字串';
const titles=['街角书店第一版','柜台摆书的新开场',hiddenTitle];
const oldDraft='原会话留下的未完成草稿。';
const model=await modelFixture({respond({text,sources}){
  const writeNumber=Number(text.match(/演练生成第([123])号稿/)?.[1]??1);
  const refs=sources.map(file=>[{material:file.id,quote:file.content.split('\n').at(-1)}]);
  return {title:titles[writeNumber-1],segments:[
    {name:'开门',start:0,end:12,spoken:'第 '+writeNumber+' 次开场。',visual:'门外固定镜头。'+bodyTag,subtitle:'街角书店',evidence:refs[0]},
    {name:'翻书',start:12,end:29,spoken:'听过开门声，再听纸页。',visual:'书页翻动近景。',subtitle:'留一点翻页声',evidence:refs[1]}
  ],notes:[]};
}});
const checks=[];
const pass=message=>{checks.push(message);console.log('OK '+message);};
let host;
const method=body=>body===undefined?{}:{method:'POST',
  headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)};

async function api(route,body,status) {
  const response=await fetch(host.origin+'/api'+route,{...method(body),signal:AbortSignal.timeout(9500)});
  const output=await response.json();
  if(status) assert.equal(response.status,status,JSON.stringify(output));
  else assert.ok(response.ok,JSON.stringify(output));
  return output;
}
const conversation=(title,options={})=>api('/rooms',{botId:'brief',revision:1,title,...options},201).then(row=>row.id);
const room=id=>api('/rooms/'+id);
const library=()=>api('/library');
const relativeHref=record=>'#chat/'+record.conversation+'?artifact='+record.id;
function untilLabel(value) {return value?.error??value?.state??'未收到终态';}

async function stage(id,runId,expected) {
  const timeout=AbortSignal.timeout(55000);
  for (;;) {
    timeout.throwIfAborted();
    const current=await room(id);
    const run=current.runs.find(item=>item.id===runId);
    if(run?.state===expected)return {current,run};
    if(['failed','cancelled','interrupted','succeeded'].includes(run?.state)) {
      throw new Error('Expected '+expected+', got '+untilLabel(run));
    }
    await delay(180,null,{signal:timeout});
  }
}

async function openApproval(id,number,base=null) {
  const {draft,artifacts}=await room(id);
  const attachments=base?artifacts.find(item=>item.id===base).materialIds:draft.attachments;
  const response=await api('/rooms/'+id+'/runs',{
    text:'演练生成第'+number+'号稿，用文字材料整理成分镜。',attachments,
    base,clientRequestId:randomUUID(),authorized:true
  },202);
  return (await stage(id,response.id,'waiting_approval')).run;
}

async function produce(id,number,base=null) {
  const {id:runId,approval}=await openApproval(id,number,base);
  await api('/runs/'+runId+'/decide',{id:approval.id,digest:approval.digest,allow:true},202);
  const {current,run}=await stage(id,runId,'succeeded');
  return current.artifacts.find(record=>record.id===run.artifact);
}

function checkArchive(bytes,expected,unavailable=0) {
  const files=unzipSync(bytes);
  const manifest=JSON.parse(strFromU8(files['版本与来源.json']));
  const index=strFromU8(files['打开成果.md']);
  assert.equal(manifest.format,'hyper-bot-history');
  assert.deepEqual(manifest.bot,{id:'media',name:'自媒体口播',revision:1});
  assert.deepEqual(manifest.counts,{conversations:2,exported:expected.length,unavailable});
  assert.equal(Object.keys(files).length,expected.length+2);
  assert.deepEqual(manifest.versions.map(version=>version.id),expected.map(record=>record.id));
  for (const [position,version] of manifest.versions.entries()) {
    const record=expected[position];
    assert.equal(version.conversationId,record.conversation);
    assert.equal(version.workbench.id,record.receipt.id);
    assert.equal(version.previous,record.previous);
    assert.equal(version.simulation,true);
    assert.deepEqual(version.sources.map(item=>item.id),record.materialIds);
    assert.equal(version.sha256,createHash('sha256').update(files[version.file]).digest('hex'));
    assert.ok(index.includes(version.file));
    const markdown=strFromU8(files[version.file]);
    assert.ok(markdown.startsWith('# '+record.result.title));
    assert.ok(markdown.includes(bodyTag));
    assert.ok(markdown.includes('## 授权来源'));
  }
  return Object.values(files).map(file=>strFromU8(file)).join('\n');
}

async function fetchArchive() {
  const response=await fetch(host.origin+'/api'+archivePath,{headers:{'X-Hyper-Bot':'1'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/zip');
  return new Uint8Array(await response.arrayBuffer());
}

function verifySeparateStorage(first) {
  const state=host.store.read();
  const owner=state.conversations.find(item=>item.id===first.conversation);
  const storage='a'.repeat(64);
  const a={...owner,id:randomUUID(),original:{storage,createdAt:'2026-01-01T00:00:00.000Z'}};
  const b={...owner,id:randomUUID(),original:{storage,createdAt:'2026-01-02T00:00:00.000Z'}};
  const c={...owner,id:randomUUID(),original:{storage:'b'.repeat(64),createdAt:a.original.createdAt}};
  const records=[first,...[a,b,c].map(room=>({...first,id:randomUUID(),conversation:room.id}))];
  const widened={...state,conversations:[...state.conversations,a,b,c]};
  const groups=libraryView(widened,records);
  assert.equal(groups.length,4);
  assert.equal(new Set(groups.map(group=>group.id)).size,4);
  assert.deepEqual(relatedProjectVersions(widened,records,owner),[]);
  assert.ok(groups.every(item=>item.versions.length===1));
  pass('同一项目编号在独立工作台、托管区、其他目录及重新创建的项目之间分别索引');
}

async function browserCase({older,first,second,group}) {
  const script=process.env.HYPER_BOT_TEST_PLAYWRIGHT;
  if(!script)return;
  const {chromium}=createRequire(import.meta.url)(script);
  const browser=await chromium.launch({executablePath:process.env.HYPER_BOT_TEST_CHROMIUM||undefined});
  const folder=process.env.HYPER_BOT_TEST_SCREENSHOTS;
  const faults=[];
  let keepOpen=false;
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>faults.push(error.message));
    await page.goto(host.origin+'/#home');
    const history=page.getByRole('link',{name:'查看全部会话'});
    await history.waitFor();
    assert.equal(await page.locator('#workspace-nav a[href="#chat/'+older+'"]').count(),0);
    await history.click();
    await page.getByRole('combobox',{name:'按 Bot 筛选'}).selectOption('brief');
    const search=page.getByRole('searchbox',{name:'搜索会话或项目'});
    await search.fill('场记旧会话');
    const oldLink=page.getByRole('link',{name:/场记旧会话/});
    await oldLink.waitFor();
    assert.match(new URL(page.url()).hash,/^#history\?bot=brief&q=/);
    if(folder) {
      await mkdir(folder,{recursive:true});
      await page.screenshot({path:join(folder,'桌面-历史会话筛选.png'),animations:'disabled'});
    }
    await oldLink.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/#chat\//);
    const oldComposer=page.locator('.composer textarea');
    await oldComposer.waitFor();
    assert.equal(await oldComposer.inputValue(),oldDraft);
    await page.goBack();
    await page.getByRole('heading',{name:'会话记录',exact:true}).waitFor();
    assert.equal(await search.inputValue(),'场记旧会话');
    pass('真实浏览器通过全部会话、Bot 筛选和键盘找回超出侧栏范围的旧会话及草稿，返回保留筛选');

    await page.goto(host.origin+'/#bots');
    await page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'自媒体口播',exact:true})})
      .getByRole('link',{name:'查看会话'}).click();
    assert.equal(await page.getByRole('combobox',{name:'按 Bot 筛选'}).inputValue(),'media');

    const fetched=[];
    page.on('request',req=>{
      if(req.method()==='GET')fetched.push(new URL(req.url()).pathname);
    });
    await page.goto(host.origin+'/#library');
    const filter=page.getByRole('searchbox',{name:'搜索项目或稿件'});
    await filter.fill('书店 第一版');
    const project=page.getByRole('link',{name:'查看 '+group.title+' 的版本'});
    await project.waitFor();
    const card=project.locator('..');
    await card.getByRole('link',{name:'打开 v1'}).waitFor();
    assert.equal(fetched.filter(path=>path==='/api/library').length,1);
    assert.equal(fetched.filter(path=>path.startsWith('/api/rooms/')).length,0);
    await project.click();
    await page.getByRole('heading',{name:'版本记录',exact:true}).waitFor();
    const newest=page.getByRole('link',{name:'打开最新版 v2'});
    assert.equal(await newest.getAttribute('href'),relativeHref(second));
    assert.equal(await page.locator('.project-detail').evaluate(el=>getComputedStyle(el).animationDuration),'0.18s');
    const source=page.getByRole('link',{name:'拍摄笔记.md',exact:true});
    await source.waitFor();
    assert.equal(await source.getAttribute('href'),relativeHref(second)+'&material='+second.materialIds[1]);
    if(folder) await page.screenshot({path:join(folder,'桌面-成果项目版本.png'),animations:'disabled'});
    for(const width of [1024,768,390,320]) {
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      const card=await page.locator('.collection-layout').boundingBox();
      assert.ok(card.x>=0&&card.x+card.width<=width);
    }
    await page.setViewportSize({width:1440,height:900});
    await source.click();
    await page.locator('.source-paper').getByRole('heading',{name:'拍摄笔记.md',exact:true}).waitFor();
    await page.goBack();
    await newest.click();
    await page.getByRole('tab',{name:/^版本/}).click();
    const preceding=page.getByRole('link',{name:'打开前一版 v1'});
    assert.equal(await preceding.getAttribute('href'),relativeHref(first));
    await preceding.click();
    await page.waitForURL(url=>url.hash===relativeHref(first));
    await page.locator('.panel-subhead .version').getByText('v1',{exact:true}).waitFor();
    await page.getByRole('tab',{name:/^版本/}).click();
    await page.getByRole('button',{name:'继续改稿'}).click();
    await page.locator('.source-version').getByText(/v1/).waitFor();

    const phone=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
    phone.on('pageerror',error=>faults.push(error.message));
    await phone.goto(host.origin+'/#library/'+group.id);
    await phone.waitForFunction(()=>{
      const detail=document.querySelector('.project-detail');
      return !!detail && matchMedia('(prefers-reduced-motion: reduce)').matches &&
        getComputedStyle(detail).animationName==='none';
    });
    await phone.getByRole('button',{name:'打开工作区导航'}).click();
    const all=phone.getByRole('link',{name:'查看全部会话'});
    assert.ok((await all.boundingBox()).height>=44);
    await phone.keyboard.press('Escape');
    await phone.getByRole('link',{name:'拍摄笔记.md',exact:true}).click();
    await phone.locator('.source-paper').getByRole('heading',{name:'拍摄笔记.md',exact:true}).waitFor();
    await phone.goBack();
    await phone.getByRole('link',{name:'打开最新版 v2'}).click();
    const preview=phone.getByRole('dialog',{name:'会话预览'});
    await preview.waitFor();
    await preview.getByRole('tab',{name:/^版本/}).click();
    await preview.getByRole('link',{name:/打开 v1/}).click();
    await phone.waitForURL(url=>url.hash===relativeHref(first));
    await phone.locator('.panel-subhead .version').getByText('v1',{exact:true}).waitFor();
    assert.deepEqual(faults,[]);
    keepOpen=true;
    pass('浏览器只取一份成果目录，桌面与窄屏可从项目打开历史稿和授权材料，减少动效有效');
    return {browser,page,faults};
  } finally {
    if(!keepOpen)await browser.close();
  }
}

let renderer;
try {
  host=await launch({options:{data,providerKey:'hb-history-fixture',upstream:model.origin}});
  const older=await conversation('场记旧会话');
  await api('/rooms/'+older+'/draft',{text:oldDraft,attachments:[],base:null});
  const firstRoom=await conversation('街角书店的初稿',{botId:'media',example:true});
  const first=await produce(firstRoom,1);
  const secondRoom=await conversation('开场复核会话',{botId:'media',project:first.project,simulation:true,example:true});
  const second=await produce(secondRoom,2);
  assert.equal(second.version,2);
  assert.equal(first.project,second.project);
  assert.equal(second.receipt.supersedes,first.receipt.id);
  assert.equal(second.previous,first.id);
  const before=await library();
  assert.equal(before.length,1);
  const [group]=before;
  assert.deepEqual(group.versions.map(item=>item.id),[second.id,first.id]);
  assert.ok(!JSON.stringify(before).includes(bodyTag));
  assert.equal(group.title,'街角书店的初稿');
  const sources=await api('/library/'+group.id);
  assert.equal(sources.version.id,second.id);
  assert.deepEqual(sources.files.map(file=>file.id),second.materialIds);
  assert.ok(sources.files.every(file=>!Object.hasOwn(file,'content')));
  const linked=await room(secondRoom);
  assert.deepEqual(linked.projectVersions.map(item=>item.id),[first.id]);
  assert.ok(linked.projectVersions.every(item=>!Object.hasOwn(item,'result')&&!Object.hasOwn(item,'materialIds')));
  pass('同一 Workbench 项目从两个会话成稿，目录整合版本与任务归属，跨会话只传元数据');

  verifySeparateStorage(first);
  for(let index=1;index<=18;index++) await conversation('近期会话 '+index);
  const workspace=await api('/workspace');
  assert.ok(workspace.conversations.length>16);
  assert.ok(!workspace.conversations.slice(0,16).some(item=>item.id===older));
  renderer=await browserCase({older,first,second,group});

  const third=await produce(firstRoom,3,first.id);
  assert.equal(third.version,3);
  assert.equal(third.base,first.id);
  assert.equal(third.previous,second.id);
  assert.equal(third.receipt.supersedes,second.receipt.id);
  assert.equal((await api('/artifacts/'+first.id+'/export')).manifest.conversationId,firstRoom);
  pass('由旧会话的 v1 明确续稿，在原项目登记 v3，保留并链接当前前序版本 v2');

  const pending=await openApproval(secondRoom,2,second.id);
  assert.equal((await api(archivePath+'?format=summary',undefined,409)).code,'bot_active');
  // Disable while a genuine Workbench proposal is still waiting for its approval.
  if (renderer) {
    const {page}=renderer;
    await page.goto(host.origin+'/#manage');
    const card=page.locator('.manage-card').filter({has:page.getByRole('heading',{name:'自媒体口播 r1',exact:true})});
    await card.getByRole('button',{name:'停用此版'}).click();
    await card.getByText('已停用',{exact:true}).waitFor();
    await card.getByText('3 份可导出',{exact:true}).waitFor();
    const history=card.getByRole('link',{name:'查看此版会话'});
    assert.equal(await history.getAttribute('href'),'#history?bot=media&revision=1');
    await history.click();
    await page.getByRole('button',{name:'查看所有版本'}).waitFor();
    assert.equal(await page.locator('.history-list .page-row').count(),2);
    await page.getByRole('button',{name:'查看所有版本'}).click();
    assert.equal(new URL(page.url()).hash,'#history?bot=media');
  } else await api('/bots/media/1/disable',{});
  const cancelled=(await room(secondRoom)).runs.find(run=>run.id===pending.id);
  assert.equal(cancelled.state,'interrupted');
  assert.equal(cancelled.approval.status,'revoked');
  await api('/runs/'+pending.id+'/decide',{id:pending.approval.id,digest:pending.approval.digest,allow:true},409);
  assert.equal((await host.app.workbench.context(first.project)).heads.script,third.receipt.id);
  await api('/rooms',{botId:'media',revision:1,title:'停用版新会话'},409);
  const disabled=await api('/rooms/'+firstRoom+'/runs',{
    text:'停用后禁止生成',attachments:[],clientRequestId:randomUUID(),authorized:true
  },409);
  assert.equal(disabled.code,'bot_disabled');
  const old=await api('/artifacts/'+first.id+'/export');
  assert.equal(old.manifest.version,1);
  if(renderer) {
    const {page}=renderer;
    await page.goto(host.origin+'/#history?bot=media');
    const bot=page.getByRole('combobox',{name:'按 Bot 筛选'});
    await bot.getByRole('option',{name:'自媒体口播 · 已停用'}).waitFor({state:'attached'});
    const item=page.getByRole('link',{name:/街角书店的初稿.*已停用/});
    await item.waitFor();
    await item.click();
    await page.locator('.panel-subhead .version').getByText('v3',{exact:true}).waitFor();
  }
  pass('停用时撤销独立的待确认写入，阻断新会话与任务，保留原有稿件和回执');

  const denied=await fetch(host.origin+'/api'+archivePath);
  assert.equal(denied.status,403);
  const differentOrigin=await fetch(host.origin+'/api'+archivePath,{headers:{Origin:'https://invalid.example','X-Hyper-Bot':'1'}});
  assert.equal(differentOrigin.status,403);
  checkArchive(await fetchArchive(),[third,second,first]);
  pass('历史归档绑定单个 Bot 版本与原会话，包含 Markdown、回执、版本关系和来源摘要');

  await api('/rooms/'+firstRoom+'/materials/'+first.materialIds[0]+'/revoke',{confirmed:true},202);
  const updated=(await library()).find(item=>item.id===group.id);
  assert.deepEqual(updated.versions.map(item=>item.title),[null,titles[1],null]);
  assert.ok(!JSON.stringify(updated).includes(hiddenTitle));
  assert.equal((await api('/library/'+group.id)).version.id,second.id);
  assert.equal((await room(secondRoom)).projectVersions.find(item=>item.id===third.id).title,null);
  await api('/artifacts/'+third.id+'/export',undefined,410);
  const readable=await api('/artifacts/'+second.id+'/export');
  assert.equal(readable.manifest.version,2);
  const contents=checkArchive(await fetchArchive(),[second],2);
  assert.ok(!contents.includes(hiddenTitle)&&!contents.includes(titles[0]));
  assert.equal((await api('/workspace')).bots.find(bot=>bot.id==='media').history.exportable,1);
  if(renderer) {
    const {page,faults}=renderer;
    await page.goto(host.origin+'/#library/'+group.id);
    await page.getByRole('link',{name:'打开 v2',exact:true}).waitFor();
    await page.locator('.collection-version[href="'+relativeHref(third)+'"]').click();
    await page.getByRole('heading',{name:'稿件内容已清理',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'导出稿件'}).count(),0);
    await page.goto(host.origin+'/#library');
    await page.getByRole('searchbox',{name:'搜索项目或稿件'}).fill(hiddenTitle);
    await page.getByRole('heading',{name:'没有匹配的成果'}).waitFor();
    await page.goto(host.origin+'/#manage');
    const card=page.locator('.manage-card').filter({has:page.getByRole('heading',{name:'自媒体口播 r1',exact:true})});
    await card.getByText('1 份可导出，2 个仅保留版本记录',{exact:true}).waitFor();
    const exportButton=card.getByRole('button',{name:'导出历史成果'});
    const frame=await page.locator('.app-shell').evaluate(shell=>({
      height:shell.clientHeight,scrollHeight:shell.scrollHeight,
      railTop:shell.querySelector('.rail-head').getBoundingClientRect().top,
      railBottom:shell.querySelector('.rail-foot').getBoundingClientRect().bottom
    }));
    assert.equal(frame.height,900);
    assert.equal(frame.scrollHeight,900);
    assert.equal(frame.railTop,0);
    assert.equal(frame.railBottom,900);
    const screenshots=process.env.HYPER_BOT_TEST_RETIREMENT_SHOTS;
    if(screenshots) {
      await mkdir(screenshots,{recursive:true});
      await page.getByText('已停用此版，待确认的写入授权已撤销。',{exact:true}).waitFor({state:'hidden'});
      await page.locator('.route-page').evaluate(page=>page.scrollTo({top:0}));
      await page.screenshot({path:join(screenshots,'桌面-停用与历史导出.png'),animations:'disabled'});
    }
    const event=page.waitForEvent('download');
    await exportButton.focus();
    await page.keyboard.press('Enter');
    const download=await event;
    assert.equal(download.suggestedFilename(),'Hyper Bot media-r1-历史成果.zip');
    const dest=join(data,'浏览器导出.zip');
    await download.saveAs(dest);
    checkArchive(await readFile(dest),[second],2);
    await page.getByText('已开始下载 1 份历史成果。',{exact:true}).waitFor();
    const narrow=await renderer.browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
    narrow.on('pageerror',error=>faults.push(error.message));
    await narrow.goto(host.origin+'/#manage');
    const mobileButton=narrow.getByRole('button',{name:'导出历史成果'});
    await mobileButton.waitFor();
    await narrow.waitForFunction(()=>{
      const page=document.querySelector('.page-content');
      return !!page && matchMedia('(prefers-reduced-motion: reduce)').matches &&
        getComputedStyle(page).animationName==='none';
    });
    for (const width of [1024,768,390,320]) {
      await narrow.setViewportSize({width,height:844});
      assert.equal(await narrow.evaluate(()=>document.documentElement.scrollWidth),width);
      const box=await mobileButton.boundingBox();
      assert.ok(box.x>=0&&box.x+box.width<=width);
      if (width<=390) assert.ok(box.height>=44);
      if(width===390 && screenshots) {
        await mobileButton.scrollIntoViewIfNeeded();
        await narrow.screenshot({path:join(screenshots,'手机-停用与历史导出.png'),animations:'disabled'});
      }
    }
    assert.deepEqual(faults,[]);
  }
  assert.equal(model.calls.length,4);
  pass('撤回后归档只含仍有授权的版本');
  if(renderer) pass('维护页通过键盘下载、触控尺寸、视口和减少动效的真实浏览器验证');

  const report={mode:'实际 DSH Web Host 和 Workbench，模型协议夹具',checks,project:first.project,
    versions:[first,second,third].map(item=>({version:item.version,conversation:item.conversation,receipt:item.receipt.id})),
    modelRequests:model.calls.length,conversationCount:workspace.conversations.length};
  if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await renderer?.browser.close();
  await host?.close();
  await model.close();
}

