import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { modelFixture } from '../test/model-fixture.mjs';
import { readWindow, windowRequest } from '../test/native-api.mjs';

const [folder,previous]=process.argv.slice(2).map(value=>path.resolve(value));
assert.ok(folder&&previous,'Specify the candidate folder and the previous Windows bundle folder.');
const source=process.env.HYPER_BOT_TEST_PROVIDER_SOURCE==='1';
const root=source?folder:path.join(folder,'resources','app');
const program=source?path.join(folder,'node_modules','electron','dist','electron.exe'):path.join(folder,'Hyper Bot.exe');
const sourceNode=source?process.execPath:null;
const oldProgram=path.join(previous,'Hyper Bot.exe');
const tmp=await mkdtemp(path.join(tmpdir(),'hb-provider-preferences-'));
const data=path.join(tmp,'配置工作区'),alternate=path.join(tmp,'第二工作区');
const credentialFile=path.join(data,'desktop','deepseek-credential.dpapi');
const modelKeys=[0,1,2].map(()=> 'synthetic-hyperbot-'+randomUUID());
const [first,replacement,environmentKey]=modelKeys;
const pictures=process.env.HYPER_BOT_TEST_SCREENSHOTS;
const env={...process.env,HYPER_BOT_HERMES_ROOT:path.join(tmp,'missing-hermes'),HYPER_BOT_WORKBENCH_ROOT:path.join(tmp,'missing-workbench')};
for(const name of Object.keys(env))if(/^(deepseek_api_key|hyper_bot_node_runtime)$/i.test(name))delete env[name];
const {_electron}=createRequire(import.meta.url)(process.env.HYPER_BOT_TEST_PLAYWRIGHT??'playwright');
const checks=[];
const pass=value=>{checks.push(value);console.log('OK '+value);};
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const widths=[[1440,900],[1024,768],[768,1024],[390,844],[320,750]];
const modal=page=>page.getByRole('dialog');
const provider=page=>page.getByRole('region',{name:'DeepSeek 模型凭据',exact:true});
const config=page=>readWindow(page,'/api/workspace');
const lock=()=>readFile(path.join(data,'host.lock'),'utf8').then(JSON.parse);

async function session(where,callback,{old=false,withEnvironment=false}={}) {
  const app=await _electron.launch({
    executablePath:old?oldProgram:program,cwd:old?previous:folder,
    args:source&&!old?[path.join(root,'desktop/main.mjs')]:[],
    env:{...env,HYPER_BOT_DATA_DIR:where,
      ...(source&&!old?{HYPER_BOT_NODE_RUNTIME:sourceNode}:{}),
      ...(withEnvironment?{DEEPSEEK_API_KEY:environmentKey}:{})},
    timeout:35000
  });
  try {
    const page=await app.firstWindow();
    await page.evaluate(()=>{location.hash='manage/dependencies';});
    await provider(page).waitFor();
    return await callback(page,app);
  } finally {await app.close();}
}

async function setup(page,value,action='配置凭据') {
  await button(provider(page),action).click();
  const dialog=modal(page);
  await dialog.getByLabel('DeepSeek API Key',{exact:true}).fill(value);
  await button(dialog,'加密保存').click();
  return dialog;
}

async function noKeyInWorkspace(page,key) {
  const snapshot=await config(page);
  assert.equal(JSON.stringify(snapshot).includes(key),false);
  assert.equal(await page.evaluate(value=>Object.values(localStorage).some(item=>item.includes(value))||
    Object.values(sessionStorage).some(item=>item.includes(value)),key),false);
  return snapshot.localDependencies.checks.provider;
}

async function photo(page,name) {
  if(!pictures)return;
  await mkdir(pictures,{recursive:true});
  await page.screenshot({path:path.join(pictures,name+'.png'),animations:'disabled'});
}

const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const previousVersion=JSON.parse(await readFile(path.join(previous,'resources','app','package.json'),'utf8')).version;
const previousRelease=JSON.parse(await readFile(path.join(previous,'发布候选清单.json'),'utf8'));
let roomId,initialCipher,replacedCipher;
await session(data,async(page,app)=>{
  const missing=await config(page);
  assert.deepEqual(missing.localDependencies.checks.provider,{
    ok:false,code:'credential',reason:'未配置 DeepSeek 模型凭据。',source:null,
    local:'missing',canStore:true,environmentFallback:false
  });
  const profiles=await page.evaluate(()=>Object.keys(window.hyperBot).sort());
  const bridge=['exportArtifact','exportBotHistory','reconnectHost','setProviderCredential'];
  if (missing.localDependencies.runtimeSetup) bridge.push('runtimeSetup');
  assert.deepEqual(profiles,bridge.sort());
  const opener=button(provider(page),'配置凭据');
  for(const [width,height] of widths){
    await page.setViewportSize({width,height});
    await opener.click();
    const dialog=modal(page);
    await dialog.waitFor();
    const input=dialog.getByLabel('DeepSeek API Key',{exact:true});
    assert.equal(await input.getAttribute('type'),'password');
    assert.ok(await input.evaluate(node=>node===document.activeElement));
    const measurements=await dialog.evaluate(node=>{
      const workspace=document.querySelector('.route-page');
      return {duration:getComputedStyle(node).animationDuration,body:document.documentElement.scrollWidth,
        window:innerWidth,overflow:node.scrollWidth>node.clientWidth||workspace.scrollWidth>workspace.clientWidth};
    });
    assert.equal(measurements.duration,'0.24s');
    assert.ok(!measurements.overflow&&measurements.body<=measurements.window,JSON.stringify(measurements));
    if(width<=750) {
      const touch=await button(dialog,'加密保存').evaluate(node=>({
        target:node.getBoundingClientRect().height,minimum:getComputedStyle(node).minHeight,viewport:innerWidth
      }));
      assert.ok(touch.target>=43.99,JSON.stringify(touch));
    }
    await page.keyboard.press('Tab');
    assert.ok(await button(dialog,'取消').evaluate(node=>node===document.activeElement));
    await page.keyboard.press('Shift+Tab');
    if(width===1440)await photo(page,'桌面-配置模型凭据');
    if(width===390)await photo(page,'手机-配置模型凭据');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.ok(await opener.evaluate(node=>node===document.activeElement));
  }
  pass('初次启动能从本机依赖打开凭据表单，密码输入、五种宽度、240 ms 打开、Tab 和 Esc 回焦通过。');

  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({reducedMotion:'reduce'});
  await opener.click();
  const dialog=modal(page);
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(node=>getComputedStyle(node).animationDuration),'0s');
  const initial=await lock();
  const origin=new URL(page.url()).origin;
  await dialog.getByLabel('DeepSeek API Key',{exact:true}).fill(first);
  await button(dialog,'加密保存').click();
  await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await lock(),initial);
  assert.equal(new URL(page.url()).origin,origin);
  const row=await noKeyInWorkspace(page,first);
  assert.ok(row.ok&&row.source==='desktop'&&row.local==='stored');
  await provider(page).getByText('本工作区已加密保存',{exact:true}).waitFor();
  await photo(page,'桌面-模型凭据已保存');
  initialCipher=await readFile(credentialFile);
  assert.equal(initialCipher.includes(first),false);
  const decrypts=await app.evaluate(({safeStorage},{file,key})=>safeStorage.decryptString(
    process.getBuiltinModule('node:fs').readFileSync(file))===key,{file:credentialFile,key:first});
  assert.equal(decrypts,true);
  pass('实际 Windows 加密保存后立即生效，节点进程与端口保持，密文可经 Windows 加密 API 回读，工作区响应与浏览存储无凭据。');

  const sameWindow=await windowRequest(page,'/api/credentials',{value:replacement});
  assert.equal(sameWindow.status,404);
  const outside=await fetch(origin+'/api/workspace',{signal:AbortSignal.timeout(5000)});
  assert.equal(outside.status,403);
  const sibling=await app.evaluate(async ({BrowserWindow},{origin,preload})=>{
    const owner=BrowserWindow.getAllWindows()[0];
    const probe=new BrowserWindow({show:false,webPreferences:{
      session:owner.webContents.session,contextIsolation:true,sandbox:true,preload
    }});
    try {
      await probe.loadURL(origin+'/');
      return await probe.webContents.executeJavaScript(
        "window.hyperBot?.setProviderCredential('another-isolated-fixture').then(()=>false,error=>error.message.includes('凭据请求来源无效'))??false"
      );
    } finally {probe.destroy();}
  },{origin,preload:path.join(root,'desktop/preload.cjs')});
  assert.equal(sibling,true);
  assert.deepEqual(await readFile(credentialFile),initialCipher);
  pass('回环 HTTP、普通外部窗口与同源非所属窗口均不能通过凭据更新入口。');

  const invalid=await setup(page,'无效 文字','更换凭据');
  await invalid.getByRole('alert').getByText('请输入有效的 DeepSeek API Key。',{exact:true}).waitFor();
  const field=invalid.getByLabel('DeepSeek API Key',{exact:true});
  assert.equal(await field.inputValue(),'');
  assert.ok(await field.evaluate(node=>node===document.activeElement));
  assert.deepEqual(await readFile(credentialFile),initialCipher);
  await field.fill(replacement);
  await button(invalid,'加密保存').click();
  await invalid.waitFor({state:'hidden'});
  replacedCipher=await readFile(credentialFile);
  assert.notDeepEqual(replacedCipher,initialCipher);
  assert.equal(replacedCipher.includes(replacement),false);
  assert.equal(await app.evaluate(({safeStorage},{file,key})=>safeStorage.decryptString(
    process.getBuiltinModule('node:fs').readFileSync(file))===key,{file:credentialFile,key:replacement}),true);

  const opened=await windowRequest(page,'/api/rooms',{botId:'brief',revision:1,title:'合成离线草稿'});
  assert.equal(opened.status,201);
  roomId=opened.data.id;
  const draft=await windowRequest(page,'/api/rooms/'+roomId+'/draft',{text:'合成项目的离线文字。',attachments:[],base:null});
  assert.equal(draft.status,200);
  for(const suffix of ['', '-wal']){
    const bytes=await readFile(path.join(data,'hyper-bot.sqlite'+suffix)).catch(error=>{
      if(error.code!=='ENOENT')throw error;
      return Buffer.alloc(0);
    });
    assert.ok(modelKeys.every(key=>!bytes.includes(key)));
  }
  pass('格式错误会清空输入并保留旧密文；更换才原子替换文件，数据库与草稿不含凭据。');

  process.kill(initial.pid);
  const until=Date.now()+25000;
  let current;
  while(Date.now()<until){
    const writer=await lock().catch(()=>null);
    if (writer?.pid && writer.pid!==initial.pid&&writer.nonce!==initial.nonce) {
      current=await config(page).catch(()=>null);
      if(current)break;
    }
    await delay(160);
  }
  assert.equal(current?.localDependencies.checks.provider.source,'desktop');
  assert.equal(new URL(page.url()).origin,origin);
  assert.equal((await readWindow(page,'/api/rooms/'+roomId)).draft.text,'合成项目的离线文字。');
  await page.locator('.connection-banner').waitFor({state:'hidden'});
  pass('本机受控 Node 进程异常退出后，原窗口、原地址、原草稿和加密凭据一起恢复。');
});

await session(data,async(page)=>{
  const status=await noKeyInWorkspace(page,replacement);
  if (previousRelease.desktopCredentialSetup) {
    assert.equal(status.ok,true);
    assert.equal(status.source,'desktop');
  } else {
    assert.equal(status.ok,false);
  }
  assert.equal((await readWindow(page,'/api/rooms/'+roomId)).draft.text,'合成项目的离线文字。');
  assert.deepEqual(await readFile(credentialFile),replacedCipher);
},{old:true});
const {backupWorkspace,restoreWorkspace}=await import(pathToFileURL(path.join(root,'server/workspace-archive.mjs')));
const backup=path.join(tmp,'凭据排除备份');
const restored=await backupWorkspace(data,backup);
assert.ok(restored.manifest.files.every(entry=>!entry.path.includes('desktop')&&!entry.path.includes('credential')));
const database=await readFile(path.join(backup,'hyper-bot.sqlite'));
assert.ok(modelKeys.every(key=>!database.includes(key)));
await restoreWorkspace(backup,alternate);
await session(alternate,async(page)=>{
  const proof=(await config(page)).localDependencies.checks.provider;
  assert.ok(!proof.ok&&proof.local==='missing');
  assert.equal((await readWindow(page,'/api/rooms/'+roomId)).draft.text,'合成项目的离线文字。');
});
pass('回滚旧版仍可打开草稿；备份还原仅带工作区数据，新目录需要单独配置模型凭据。');

await session(data,async(page,app)=>{
  const state=await noKeyInWorkspace(page,replacement);
  assert.ok(state.ok&&state.source==='desktop'&&state.environmentFallback);
  assert.equal(await app.evaluate(({safeStorage},{file,key})=>safeStorage.decryptString(
    process.getBuiltinModule('node:fs').readFileSync(file))===key,{file:credentialFile,key:replacement}),true);
  const abandoned=credentialFile+'.pending';
  await writeFile(abandoned,replacedCipher,{flag:'wx'});
  await button(provider(page),'清除本机凭据').click();
  const dialog=modal(page);
  await dialog.getByText('清除后，本工作区使用启动环境中的凭据。',{exact:true}).waitFor();
  await button(dialog,'确认清除').click();
  await dialog.waitFor({state:'hidden'});
  assert.equal((await noKeyInWorkspace(page,environmentKey)).source,'environment');
  await assert.rejects(access(credentialFile),{code:'ENOENT'});
  await assert.rejects(access(abandoned),{code:'ENOENT'});
  pass('应用重开仍使用本机凭据，清除会一并移除未完成的密文并退回启动环境。');
},{withEnvironment:true});

await writeFile(credentialFile,Buffer.from('synthetic-invalid-ciphertext'));
await session(data,async(page)=>{
  const status=(await config(page)).localDependencies.checks.provider;
  assert.ok(!status.ok&&status.local==='unreadable');
  await provider(page).getByText('本机凭据无法读取。可更换或清除。',{exact:true}).waitFor();
  const dialog=await setup(page,first,'更换凭据');
  await dialog.waitFor({state:'hidden'});
  assert.equal((await noKeyInWorkspace(page,first)).local,'stored');
  await button(provider(page),'清除本机凭据').click();
  await button(modal(page),'确认清除').click();
  await modal(page).waitFor({state:'hidden'});
  const cleared=(await config(page)).localDependencies.checks.provider;
  assert.ok(!cleared.ok&&cleared.local==='missing');
  await assert.rejects(access(credentialFile),{code:'ENOENT'});
  assert.equal((await readWindow(page,'/api/rooms/'+roomId)).draft.text,'合成项目的离线文字。');
});
pass('损坏密文能在界面识别及替换；无启动凭据时清除会暂停模型入口，草稿仍可打开。');

const {launch}=await import(pathToFileURL(path.join(root,'server/http.mjs')));
const statusFor=key=>({key,status:{source:key?'desktop':null,local:key?'stored':'missing',canStore:true,environmentFallback:false}});
const model=await modelFixture();
const received=[];
const entered=Promise.withResolvers(), release=Promise.withResolvers();
const fixture=createServer(async (request,response)=>{
  try {
    const key=request.headers['x-api-key']??request.headers.authorization?.replace(/^Bearer /,'');
    const index=modelKeys.indexOf(key);
    if(index<0){response.writeHead(401).end();return;}
    received.push(index);
    const body=[];
    for await(const chunk of request)body.push(chunk);
    if(received.length===1){entered.resolve();await release.promise;}
    const mock=await fetch(model.origin+request.url,{method:'POST',body:Buffer.concat(body)});
    response.writeHead(mock.status,Object.fromEntries(mock.headers));
    response.end(Buffer.from(await mock.arrayBuffer()));
  } catch {response.writeHead(502).end();}
});
fixture.listen(0,'127.0.0.1');
await once(fixture,'listening');
let host,commits=0;
try {
  host=await launch({options:{data:path.join(tmp,'验证运行时'),desktopCredential:statusFor(null),
    upstream:'http://127.0.0.1:'+fixture.address().port}});
  const call=async(route,body,expected=200)=>{
    const response=await fetch(host.origin+'/api'+route,{signal:AbortSignal.timeout(25000),
      ...(body===undefined?{}:{method:'POST',headers:{'X-Hyper-Bot':'1','Content-Type':'application/json'},body:JSON.stringify(body)})});
    const result=await response.json();
    assert.equal(response.status,expected,JSON.stringify(result));
    return result;
  };
  const candidate=await call('/bots',{id:'credential-proof',name:'本机配置简报',kind:'brief',driver:'dsh-web',
    description:'核对模型凭据对下一轮任务的作用。',skills:['material-brief']},201);
  const sample='/bots/'+candidate.id+'/'+candidate.revision+'/verify';
  await call(sample,{},503);
  host.app.applyDesktopCredential(statusFor(first),()=>{commits++;});
  const active=call(sample,{});
  await Promise.race([entered.promise,delay(22000,null,{ref:false}).then(()=>{throw new Error('Model fixture has not received the request');})]);
  assert.throws(()=>host.app.applyDesktopCredential(statusFor(replacement),()=>{commits++;}),{code:'busy'});
  assert.equal(commits,1);
  release.resolve();
  assert.equal((await active).ok,true);
  assert.throws(()=>host.app.applyDesktopCredential(statusFor(replacement),()=>{throw new Error('Storage fixture refused write');}),/Storage fixture/);
  assert.equal((await call(sample,{})).ok,true);
  assert.deepEqual(received,[0,0]);
  host.app.applyDesktopCredential(statusFor(replacement),()=>{commits++;});
  assert.equal((await call(sample,{})).ok,true);
  assert.deepEqual(received,[0,0,1]);
  host.app.applyDesktopCredential(statusFor(null),()=>{commits++;});
  await call(sample,{},503);
  assert.equal(model.calls.length,3);
  assert.equal(commits,3);
  pass('真实 DSH Web Host 请求使用当前凭据，活动验证拒绝更新，保存失败保留旧值，清除后模型请求增量为零。');
} finally {
  release.resolve();
  await host?.close();
  const closed=new Promise(resolve=>fixture.close(resolve));
  fixture.closeAllConnections();
  await closed;
  await model.close();
}

const report={version,previousVersion,checks,widths:widths.map(([width])=>width),
  native:{encrypted:true,credentialsInWorkspaceBackup:false,recoveredSamePort:true,hostUpdatedInPlace:true},
  provider:{fixture:true,received:received.length,paidRequests:0,commits}};
if(process.env.HYPER_BOT_TEST_REPORT)await writeFile(process.env.HYPER_BOT_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
