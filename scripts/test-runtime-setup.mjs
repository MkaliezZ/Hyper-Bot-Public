import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { modelFixture } from '../test/model-fixture.mjs';
import { readWindow, windowRequest } from '../test/native-api.mjs';

const [folder,previous]=process.argv.slice(2).map(value=>path.resolve(value));
assert.ok(folder&&previous,'Specify the candidate and previous Windows bundle directories.');
const source=process.env.HYPER_BOT_TEST_RUNTIME_SOURCE==='1';
const root=source?folder:path.join(folder,'resources','app');
const exe=source?path.join(folder,'node_modules','electron','dist','electron.exe'):path.join(folder,'Hyper Bot.exe');
const approved={
  workbench:{root:process.env.HYPER_BOT_WORKBENCH_ROOT,python:process.env.HYPER_BOT_WORKBENCH_PYTHON},
  hermes:{root:process.env.HYPER_BOT_HERMES_ROOT,python:process.env.HYPER_BOT_HERMES_PYTHON}
};
for (const value of Object.values(approved).flatMap(Object.values)) assert.ok(value&&path.isAbsolute(value),'Frozen runtime paths are required.');
const working=await mkdtemp(path.join(tmpdir(),'hb-runtime-installation-'));
const data=path.join(working,'配置工作区');
const preferences=path.join(data,'desktop','runtime-installations.json');
const browserEnv={...process.env,HYPER_BOT_WORKBENCH_ROOT:path.join(working,'missing-workbench'),
  HYPER_BOT_HERMES_ROOT:path.join(working,'missing-hermes')};
for(const name of Object.keys(browserEnv))if(/^(deepseek_api_key|hyper_bot_node_runtime)$/i.test(name))delete browserEnv[name];
browserEnv.DEEPSEEK_API_KEY='synthetic-runtime-setup-only';
const pictures=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const {_electron}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const checks=[];
const pass=label=>{checks.push(label);console.log('OK '+label);};
const sizes=[[1440,900],[1024,768],[768,1024],[390,844],[320,750]];
const lookup=(page,id)=>page.getByRole('region',{name:id==='workbench'?'Self Media Workbench':'Hermes ACP',exact:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const workspace=page=>readWindow(page,'/api/workspace');
const lock=()=>readFile(path.join(data,'host.lock'),'utf8').then(JSON.parse);
const stored=()=>readFile(preferences,'utf8').then(JSON.parse);

async function session(callback,old=false) {
  const app=await _electron.launch({
    executablePath:old?path.join(previous,'Hyper Bot.exe'):exe,cwd:old?previous:folder,
    args:source&&!old?[path.join(root,'desktop/main.mjs')]:[],
    env:{...browserEnv,HYPER_BOT_DATA_DIR:data,...(source&&!old?{HYPER_BOT_NODE_RUNTIME:process.execPath}:{})},
    timeout:35000
  });
  try {
    const page=await app.firstWindow();
    await page.evaluate(()=>{location.hash='manage/dependencies';});
    await lookup(page,'workbench').waitFor();
    return await callback(page,app);
  } finally {await app.close();}
}

async function choose(app,dialog,field,value) {
  const name=field==='root'?'选择目录':'选择 Python';
  const opened=button(dialog,name);
  await opened.waitFor();
  await app.evaluate(({dialog},selection)=>{
    globalThis.hyperBotPickerOptions=null;
    dialog.showOpenDialog=async(_window,options)=>{
      globalThis.hyperBotPickerOptions=options;
      return selection===null?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[selection]};
    };
  },value);
  await opened.click();
  let options;
  for(let attempt=0;attempt<20&&!options;attempt++){
    options=await app.evaluate(()=>globalThis.hyperBotPickerOptions);
    if(!options)await wait(35);
  }
  assert.ok(options,'The native picker did not receive the choice request');
  assert.deepEqual(options.properties,field==='root'?['openDirectory']:['openFile']);
  if(field==='python')assert.deepEqual(options.filters[0].extensions,['exe']);
}

async function show(page,id) {
  await button(lookup(page,id),'配置安装').click();
  const dialog=page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button',{name:'选择目录',exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement.textContent==='选择目录');
  return dialog;
}

async function photo(page,name) {
  if(!pictures)return;
  await mkdir(pictures,{recursive:true});
  await page.screenshot({path:path.join(pictures,name+'.png'),animations:'disabled'});
}

async function readConfig(page,id) {
  return (await workspace(page)).localDependencies.checks[id];
}

const wrong=path.join(working,'unapproved-checkout');
await mkdir(wrong);
await writeFile(path.join(wrong,'workbench.py'),'# A local version-mismatch test fixture.\n');
const git=args=>promisify(execFile)('git',['-C',wrong,...args],{windowsHide:true,timeout:12000});
await git(['init']);
await git(['add','workbench.py']);
await git(['-c','user.name=Local test fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m','Synthetic checkout']);
const nested=path.join(wrong,'inner');
await mkdir(nested);
await writeFile(path.join(nested,'workbench.py'),'# The chooser must select the repository root.\n');
const devVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const oldVersion=JSON.parse(await readFile(path.join(previous,'resources','app','package.json'),'utf8')).version;
const oldManifest=JSON.parse(await readFile(path.join(previous,'发布候选清单.json'),'utf8'));
assert.equal(oldManifest.version,oldVersion);
const oldSupportsSetup=oldManifest.desktopRuntimeSetup===true;
let roomId,recordedBeforeReset;

await session(async page=>{
  assert.equal(await button(lookup(page,'workbench'),'配置安装').count(),Number(oldSupportsSetup));
  assert.equal((await readConfig(page,'workbench')).ok,false);
},true);

await session(async (page,app)=>{
  const opened=await windowRequest(page,'/api/rooms',{botId:'media',revision:1,title:'开门前的离线草稿',example:true});
  assert.equal(opened.status,201);
  roomId=opened.data.id;
  const original=await readWindow(page,'/api/rooms/'+roomId);
  const text='按已有文字写开门分镜，并保留最后一镜。';
  const saved=await windowRequest(page,'/api/rooms/'+roomId+'/draft',{...original.draft,text});
  assert.equal(saved.status,200);
  const initial=await lock();
  const origin=new URL(page.url()).origin;
  await page.evaluate(id=>{location.hash='manage/dependencies?bot=media&revision=1&room='+id;},roomId);
  await page.getByRole('link',{name:'返回会话',exact:true}).waitFor();
  assert.equal((await readConfig(page,'workbench')).ok,false);

  for(const [width,height] of sizes){
    await page.setViewportSize({width,height});
    const dialog=await show(page,'workbench');
    const view=await dialog.evaluate(item=>{
      const main=document.querySelector('.route-page');
      return {duration:getComputedStyle(item).animationDuration,viewport:innerWidth,
        scroll:document.documentElement.scrollWidth,overflow:item.scrollWidth>item.clientWidth||main.scrollWidth>main.clientWidth};
    });
    assert.ok(!view.overflow&&view.scroll<=view.viewport,JSON.stringify(view));
    assert.equal(view.duration,'0.24s');
    if(width<=750)assert.equal(await button(dialog,'选择目录').evaluate(el=>getComputedStyle(el).minHeight),'44px');
    assert.equal(await button(dialog,'检查并保存').isDisabled(),true);
    await page.keyboard.press('Tab');
    assert.ok(await button(dialog,'选择 Python').evaluate(node=>node===document.activeElement));
    await page.keyboard.press('Shift+Tab');
    if(width===1440)await photo(page,'桌面-配置工作台安装');
    if(width===390)await photo(page,'手机-配置工作台安装');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.ok(await button(lookup(page,'workbench'),'配置安装').evaluate(node=>node===document.activeElement));
  }
  pass((oldSupportsSetup?'上一版已支持组件登记。':'上一版尚无组件登记。')+'候选包可从原会话打开本机安装设置，五种视口、弹窗动效和键盘回焦通过。');

  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({reducedMotion:'reduce'});
  const setup=await show(page,'workbench');
  assert.equal(await setup.evaluate(node=>getComputedStyle(node).animationDuration),'0s');
  await choose(app,setup,'root',null);
  assert.equal(await setup.getByText('未选择',{exact:true}).count(),2);
  await choose(app,setup,'root',nested);
  await choose(app,setup,'python',path.join(working,'unavailable.exe'));
  await button(setup,'检查并保存').click();
  await setup.getByRole('alert').getByText('请选择该组件的 Git 仓库根目录。',{exact:true}).waitFor();
  await choose(app,setup,'root',wrong);
  await button(setup,'检查并保存').click();
  await setup.getByRole('alert').getByText('当前提交与已锁定版本不同。',{exact:true}).waitFor();
  assert.deepEqual(await lock(),initial);
  pass('系统选择取消保留当前状态。子目录和错误提交优先被拒绝，未启动候选 Python 或重启 Host。');

  await choose(app,setup,'root',approved.workbench.root);
  await button(setup,'检查并保存').click();
  await setup.getByRole('alert').getByText('所选 Python 无法读取。',{exact:true}).waitFor();
  await choose(app,setup,'python',approved.workbench.python);
  await photo(page,'桌面-待检查的工作台安装');
  await button(setup,'检查并保存').click();
  await setup.waitFor({state:'hidden',timeout:45000});
  const workbench=await readConfig(page,'workbench');
  assert.ok(workbench.ok&&workbench.source==='desktop');
  assert.equal((await stored()).workbench.root,await realpath(approved.workbench.root));
  assert.notEqual((await lock()).nonce,initial.nonce);
  assert.equal(new URL(page.url()).origin,origin);
  assert.equal((await readWindow(page,'/api/rooms/'+roomId)).draft.text,text);
  assert.ok(Array.isArray(await readWindow(page,'/api/projects')));
  await photo(page,'桌面-工作台安装已登记');
  await page.getByRole('link',{name:'返回会话',exact:true}).click();
  const composer=page.locator('#message');
  await composer.waitFor();
  assert.equal(await composer.inputValue(),text);
  pass('真实锁定版本和 Python 检查成功，Host 在原窗口原地址重启，可返回原会话和草稿，并能打开实际工作台项目列表。');

  await page.evaluate(()=>{location.hash='manage/dependencies';});
  const hermes=await show(page,'hermes');
  await choose(app,hermes,'root',approved.hermes.root);
  await choose(app,hermes,'python',approved.hermes.python);
  await button(hermes,'检查并保存').click();
  await hermes.waitFor({state:'hidden',timeout:45000});
  const both=await workspace(page);
  assert.ok(both.localDependencies.checks.hermes.ok);
  assert.equal(both.localDependencies.checks.hermes.source,'desktop');
  assert.equal(both.localDependencies.checks.workbench.source,'desktop');
  assert.ok(!JSON.stringify(both.localDependencies).includes(approved.workbench.root));
  assert.ok(!JSON.stringify(both.localDependencies).includes(approved.hermes.python));
  recordedBeforeReset=await stored();
  pass('Hermes 和工作台分别登记，派活前诊断只返回版本与状态，安装路径留在本机设置。');

  const owner=await windowRequest(page,'/api/runtime-installations',{id:'workbench'});
  assert.equal(owner.status,404);
  const sibling=await app.evaluate(async({BrowserWindow},{origin,preload})=>{
    const master=BrowserWindow.getAllWindows()[0];
    const guest=new BrowserWindow({show:false,webPreferences:{session:master.webContents.session,preload,sandbox:true,contextIsolation:true}});
    try {
      await guest.loadURL(origin+'/');
      return await guest.webContents.executeJavaScript(
        "window.hyperBot.runtimeSetup.begin('workbench').then(()=>false,error=>error.message.includes('组件配置请求来源无效'))"
      );
    } finally {guest.destroy();}
  },{origin,preload:path.join(root,'desktop/preload.cjs')});
  assert.equal(sibling,true);
  const current=await lock();
  const swap=await show(page,'workbench');
  await choose(app,swap,'root',wrong);
  await button(swap,'检查并保存').click();
  await swap.getByRole('alert').getByText('当前提交与已锁定版本不同。',{exact:true}).waitFor();
  assert.deepEqual(await lock(),current);
  assert.deepEqual(await stored(),recordedBeforeReset);
  assert.equal((await readConfig(page,'workbench')).ok,true);
  await button(swap,'取消').click();
  await swap.waitFor({state:'hidden'});
  pass('回环 HTTP 和同源非所属窗口无法变更安装。失败的替换保留两项原配置及运行中的 Host。');
});

await session(async page=>{
  for(const id of ['workbench','hermes']){
    const check=await readConfig(page,id);
    assert.equal(check.ok,oldSupportsSetup);
    if(oldSupportsSetup)assert.equal(check.source,'desktop');
  }
  assert.ok((await readWindow(page,'/api/rooms/'+roomId)).draft.text);
  assert.deepEqual(await stored(),recordedBeforeReset);
},true);
await session(async page=>{
  assert.equal((await readConfig(page,'workbench')).source,'desktop');
  assert.ok((await readConfig(page,'hermes')).ok);
  const dialog=await show(page,'workbench');
  await button(dialog,'恢复自动查找').click();
  await button(dialog,'确认恢复').click();
  await dialog.waitFor({state:'hidden',timeout:45000});
  assert.equal((await readConfig(page,'workbench')).source,'automatic');
  assert.equal((await readConfig(page,'workbench')).ok,false);
  assert.equal((await readConfig(page,'hermes')).ok,true);
  assert.deepEqual((await stored()).hermes,recordedBeforeReset.hermes);
  assert.ok((await readWindow(page,'/api/rooms/'+roomId)).draft.text);
});
pass('回滚时旧草稿仍在，升级后恢复已登记设置；恢复工作台自动查找时保留 Hermes 及原会话。');

const {launch}=await import(pathToFileURL(path.join(root,'server/http.mjs')));
const model=await modelFixture();
const host=await launch({options:{data:path.join(working,'模型夹具工作区'),providerKey:'fixture-only',
  upstream:model.origin,desktopInstallations:{overrides:{workbench:recordedBeforeReset.workbench,hermes:recordedBeforeReset.hermes},issue:false}}});
async function api(route,body,expected=200) {
  const response=await fetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(12000),
    ...(body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  assert.equal(response.status,expected,JSON.stringify(result));
  return result;
}
async function send(id,text) {
  const room=(await api('/rooms',{botId:id,revision:1,title:'锁定安装验收',example:true},201)).id;
  const {draft}=await api('/rooms/'+room);
  const result=await api('/rooms/'+room+'/runs',{...draft,text,authorized:true,clientRequestId:randomUUID()},202);
  return {room,id:result.id};
}
async function phase(job,expected) {
  const signal=AbortSignal.timeout(90000);
  for(;;){
    const current=(await api('/rooms/'+job.room)).runs.find(row=>row.id===job.id);
    if(current.state===expected)return current;
    if(['failed','interrupted','cancelled'].includes(current.state))throw Error(JSON.stringify(current));
    await wait(140,null,{signal});
  }
}
try {
  const script=await send('media','按采访写开门准备的四镜口播。');
  const ready=await phase(script,'waiting_approval');
  let changed=false;
  await assert.rejects(host.app.prepareRuntimeInstallation('workbench',null,()=>{changed=true;}),{code:'busy'});
  assert.equal(changed,false);
  await api('/runs/'+script.id+'/decide',{id:ready.approval.id,digest:ready.approval.digest,allow:true},202);
  const saved=await phase(script,'succeeded');
  assert.ok(saved.artifact&&(await api('/rooms/'+script.room)).artifacts[0].receipt.id);
  const brief=await send('brief','归纳书店开门前的材料。');
  assert.ok((await phase(brief,'succeeded')).artifact);
  assert.equal(model.calls.length,2);
  for(let i=0;i<60&&host.app.jobs.size;i++)await wait(100);
  await host.app.prepareRuntimeInstallation('workbench',null,()=>{changed=true;});
  assert.equal(changed,true);
  assert.equal((await api('/workspace',undefined,503)).code,'runtime_restarting');
  pass('选定安装实跑 DSH 口播、工作台写入和 Hermes 简报。等待审批时拒绝切换，应用设置时停止接收新任务。');
} finally {
  await host.close();
  await model.close();
}
const report={version:devVersion,previous:oldVersion,checks,viewports:sizes.map(([width])=>width),
  selection:{dialogFixture:true,sameWindow:true,oldDraftReadable:true,dualRuntime:true,previousSupportsSetup:oldSupportsSetup},
  integration:{modelFixture:true,modelCalls:model.calls.length,paidRequests:0}};
if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
