import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readWindow, windowRequest } from '../test/native-api.mjs';

const require=createRequire(import.meta.url);
const {_electron}=require(process.env.HYPER_BOT_TEST_PLAYWRIGHT || 'playwright');
const exec=promisify(execFile);
const [directory,oldSource,oldElectron,backupDir]=process.argv.slice(2,6).map(arg=>path.resolve(arg));
const testHostRestart=process.argv.includes('--repeat-host-restart');
const testHostStartRetry=process.argv.includes('--host-start-retry');
const testHistoryNavigation=process.argv.includes('--history-navigation');
const testRecoveryNavigation=process.argv.includes('--recovery-navigation');
const testDependencies=process.argv.includes('--readiness');
const testReceipts=process.argv.includes('--receipts');
const testHistoryExport=process.argv.includes('--history-export');
const testWorkspaceCleanup=process.argv.includes('--workspace-cleanup');
const testWindowAccess=process.argv.includes('--window-access');
const testArtifactBundle=process.argv.includes('--artifact-bundle');
if(!backupDir)throw new Error('Provide the extracted new package, earlier app directory and executable, and an archived sample workspace.');
const executable=path.join(directory,'Hyper Bot.exe');
const earlierPackaged=path.basename(oldElectron)==='Hyper Bot.exe';
const hostNode=path.join(directory,'resources/node/node.exe');
const manifest=JSON.parse(await readFile(path.join(directory,'发布候选清单.json'),'utf8'));
const archiveTool=path.join(directory,'resources/app/scripts/workspace.mjs');
const testRoot=await mkdtemp(path.join(tmpdir(),'hb-package-'));
const fresh=path.join(testRoot,'新用户工作区');
const upgrade=path.join(testRoot,'升级工作区');
const deviceEnv={...process.env,LOCALAPPDATA:path.join(testRoot,'AppData'),APPDATA:path.join(testRoot,'Roaming')};
delete deviceEnv.HYPER_BOT_NODE_RUNTIME;
delete deviceEnv.DEEPSEEK_API_KEY;
deviceEnv.HYPER_BOT_HERMES_ROOT=path.join(testRoot,'missing-hermes');
deviceEnv.HYPER_BOT_WORKBENCH_ROOT=path.join(testRoot,'missing-workbench');
deviceEnv.PATH=path.join(process.env.SystemRoot ?? 'C:/Windows','System32');
for (const name of Object.keys(deviceEnv)) {
  if(name.toUpperCase()==='PATH'&&name!=='PATH')delete deviceEnv[name];
}
await mkdir(deviceEnv.LOCALAPPDATA);
await mkdir(deviceEnv.APPDATA);

const node=(args,env=deviceEnv)=>exec(hostNode,args,{env,windowsHide:true,timeout:18000});
async function checkExecutableIdentity() {
  const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const command=`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$info=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:HYPER_BOT_TEST_EXECUTABLE)
Add-Type -AssemblyName System.Drawing
$icon=[Drawing.Icon]::ExtractAssociatedIcon($env:HYPER_BOT_TEST_EXECUTABLE)
$actual=$icon.ToBitmap()
$mark=[Drawing.Image]::FromFile($env:HYPER_BOT_TEST_MARK)
$reference=[Drawing.Bitmap]::new($actual.Width,$actual.Height)
$graphics=[Drawing.Graphics]::FromImage($reference)
try {
  $graphics.CompositingMode=[Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($mark,0,0,$reference.Width,$reference.Height)
  $distance=[double]0
  for ($y=0;$y -lt $reference.Height;$y++) {
    for ($x=0;$x -lt $reference.Width;$x++) {
      $a=$actual.GetPixel($x,$y)
      $b=$reference.GetPixel($x,$y)
      $alphaA=$a.A/255
      $alphaB=$b.A/255
      $distance+=[Math]::Abs($a.A-$b.A)+[Math]::Abs($a.R*$alphaA-$b.R*$alphaB)+
        [Math]::Abs($a.G*$alphaA-$b.G*$alphaB)+[Math]::Abs($a.B*$alphaA-$b.B*$alphaB)
    }
  }
  [pscustomobject]@{product=$info.ProductName;description=$info.FileDescription;internalName=$info.InternalName;
    originalFilename=$info.OriginalFilename;fileVersion=$info.FileVersion;version=$info.ProductVersion;
    iconSize=@($actual.Width,$actual.Height);iconDistance=[Math]::Round($distance/($reference.Width*$reference.Height*4),2)} | ConvertTo-Json -Compress
} finally {
  $graphics.Dispose()
  $reference.Dispose()
  $mark.Dispose()
  $actual.Dispose()
  $icon.Dispose()
}
`;
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{
    env:{...deviceEnv,HYPER_BOT_TEST_EXECUTABLE:executable,HYPER_BOT_TEST_MARK:path.join(directory,'resources/app/public/media/mark.png')},
    windowsHide:true,timeout:15000,encoding:'utf8'
  });
  const identity=JSON.parse(stdout);
  assert.deepEqual([identity.product,identity.description,identity.internalName],[manifest.product,manifest.product,manifest.product]);
  assert.equal(identity.originalFilename,'Hyper Bot.exe');
  assert.equal(identity.version,manifest.version);
  assert.equal(identity.fileVersion,manifest.version);
  assert.ok(identity.iconSize.every(size=>Number.isInteger(size)&&size>=16),'Windows must resolve the application icon.');
  assert.ok(Number.isFinite(identity.iconDistance)&&identity.iconDistance<25,'The Windows shell icon must match the packaged mark.');
  return identity;
}

const executableIdentity=manifest.windowsIdentity?await checkExecutableIdentity():null;

const launch=(data,earlier=false)=>_electron.launch({
  executablePath:earlier?oldElectron:executable, cwd:earlier?oldSource:directory,
  args:earlier&&!earlierPackaged?[path.join(oldSource,'desktop/main.mjs')]:[],
  env:{...deviceEnv,HYPER_BOT_DATA_DIR:data,...(earlier&&!earlierPackaged?{HYPER_BOT_NODE_RUNTIME:hostNode}:{})},
  timeout:35000
});

async function session(data,earlier,check) {
  const app=await launch(data,earlier);
  try {
    const page=await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
    await page.getByRole('heading',{name:'工作台',exact:true}).waitFor({timeout:12000});
    const api=route=>readWindow(page,route);
    assert.equal(await page.title(),'Hyper Bot');
    const source=await app.evaluate(({app,BrowserWindow})=>({
      version:app.getVersion(),sandbox:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox
    }));
    const workspace=await api('/api/workspace');
    return await check({app,page,api,source,workspace});
  } finally {await app.close();}
}

async function checkWindowAccess(app,page) {
  const origin=new URL(page.url()).origin;
  const paths=['/api/workspace','/api/events','/api/receipts','/api/runs/00112233-4455-4677-8899-aabbccddeeff/decide'];
  for (const route of paths) {
    const approval=route.endsWith('/decide');
    const response=await fetch(origin+route,{signal:AbortSignal.timeout(4000),
      headers:{'X-Hyper-Bot':'1',Origin:origin,...(approval?{'Content-Type':'application/json'}:{})},
      ...(approval?{method:'POST',body:'{}'}:{})});
    if (response.status!==403) await response.body?.cancel();
    assert.equal(response.status,403,route);
    assert.equal((await response.json()).code,'window_access');
  }
  const sibling=await app.evaluate(async ({BrowserWindow,app},origin)=>{
    const owner=BrowserWindow.getAllWindows()[0];
    const preload=process.getBuiltinModule('node:path').join(app.getAppPath(),'desktop','preload.cjs');
    const probe=new BrowserWindow({show:false,webPreferences:{session:owner.webContents.session,sandbox:true,contextIsolation:true,preload}});
    try {
      await probe.loadURL(origin+'/');
      return await probe.webContents.executeJavaScript(
        "Promise.all([fetch('/api/workspace').then(response=>response.status,()=>0),"+
          "window.hyperBot?.reconnectHost?.().then(()=>false,error=>error.message.includes('重连请求来源无效'))??'bridge absent'])"
      );
    } finally {probe.destroy();}
  },origin);
  assert.ok(sibling[0]===0 || sibling[0]===403);
  assert.equal(sibling[1],true);
  const bridge=['exportArtifact','exportBotHistory','exportSpecialist','reconnectHost'];
  if (manifest.desktopCredentialSetup) bridge.push('setProviderCredential');
  if (manifest.desktopRuntimeSetup) bridge.push('runtimeSetup');
  assert.deepEqual(await page.evaluate(()=>Object.keys(window.hyperBot).sort()),bridge.sort());
  return {unauthorizedRoutes:paths.length,unownedWindowDenied:true,credentialHiddenFromPreload:true,unownedReconnectDenied:true};
}

const nodeVersion=(await node(['--version'])).stdout.trim();
const clean=await session(fresh,false,async ({app,page,api,source,workspace})=>{
  assert.equal(source.version,manifest.version);
  assert.equal(source.sandbox,true);
  assert.equal(workspace.conversations.length,0);
  assert.ok(workspace.bots.filter(bot=>bot.kind!=='teaching').every(bot=>bot.blocked));
  await assert.rejects(node([archiveTool,'backup',fresh,path.join(testRoot,'blocked')]),/已有 Hyper Bot 进程/);
  if(testRecoveryNavigation) {
    const entry=page.locator('#workspace-nav').getByRole('link',{name:'断线核对',exact:true});
    if(!await entry.isVisible())await page.getByRole('button',{name:'打开工作区导航'}).click();
    await entry.click();
    await page.getByRole('heading',{name:'暂无写入核对记录',exact:true}).waitFor();
    assert.deepEqual((await api('/api/recoveries')).rows,[]);
    await page.getByRole('link',{name:'返回工作台',exact:true}).click();
    await page.getByRole('heading',{name:'工作台',exact:true}).waitFor();
  }
  if(testDependencies) {
    const media=page.locator('.directory-card').filter({has:page.getByRole('heading',{name:'自媒体口播',exact:true})});
    await media.getByRole('link',{name:'检查依赖',exact:true}).click();
    await page.getByRole('heading',{name:'本机依赖',exact:true}).waitFor();
    await page.getByText('已配置目录里找不到组件入口。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Hermes ACP',exact:true}).count(),0);
    assert.equal(workspace.localDependencies.checks.provider.code,'credential');
    assert.equal(workspace.localDependencies.checks['dsh-web'].ok,true);
    await page.getByRole('button',{name:'重新检查',exact:true}).click();
    await page.waitForFunction(stamp=>{
      const checked=document.querySelector('.dependency-stamp time')?.dateTime;
      return checked&&checked!==stamp;
    },workspace.localDependencies.checkedAt);
  }
  const windowAccess=testWindowAccess?await checkWindowAccess(app,page):null;
  return {version:source.version,node:nodeVersion,defaultMediaDriver:workspace.bots.find(item=>item.id==='media')?.driver,
    ...(windowAccess?{windowAccess}:{}),
    disabledByMissingDependencies:workspace.bots.filter(bot=>bot.blocked).length,activeBackupRefused:true,
    ...(testRecoveryNavigation?{recoveryNavigation:true}:{}),...(testDependencies?{readinessNavigation:true}:{})};
});

await node([archiveTool,'restore',backupDir,upgrade]);

let hostRestarts=0, reconnectedEventStreams=0,historyNavigation=false,receiptNavigation=false;
async function restartHost(api,page,room,artifacts) {
  const marker=()=>readFile(path.join(upgrade,'host.lock'),'utf8').then(JSON.parse);
  const prior=await marker();
  const updates=testWindowAccess? page.waitForResponse(response=>
    response.status()===200 && new URL(response.url()).pathname==='/api/events',
    {timeout:24000}).catch(()=>null):null;
  process.kill(prior.pid);
  const deadline=Date.now()+24000;
  let confirmed=false;
  while(Date.now()<deadline) {
    const current=await marker().catch(()=>null);
    if (current?.pid && current.pid!==prior.pid && current.nonce!==prior.nonce) {
      if (await api('/api/workspace').catch(()=>null)) {
        confirmed=true;
        break;
      }
    }
    await sleep(180);
  }
  assert.ok(confirmed,'Hyper Bot 主进程尚未在原地址恢复服务。');
  const restored=await api('/api/rooms/'+room);
  assert.deepEqual(restored.artifacts.map(record=>record.id),artifacts);
  await page.locator('.connection-banner').waitFor({state:'hidden'});
  if (updates) {
    assert.ok(await updates,'服务重启后，原窗口的事件流未恢复。');
    reconnectedEventStreams++;
  }
  hostRestarts++;
}

async function history({app,page,api,workspace},confirmExport) {
  const room=workspace.conversations.find(item=>item.botId==='media');
  const data=await api('/api/rooms/'+room.id);
  assert.equal(data.artifacts.length,2);
  assert.equal(data.artifacts[1].receipt.supersedes,data.artifacts[0].receipt.id);
  const [{id:first},{id:second}]=data.artifacts;
  await page.evaluate(id=>{location.hash='chat/'+id;},room.id);
  await page.getByRole('button',{name:'导出稿件'}).waitFor();
  const assertVersion=version=>page.locator('.panel-subhead .version').getByText(version,{exact:true}).waitFor();
  await assertVersion('v2');
  await page.getByRole('tab',{name:/版本/}).click();
  await page.locator('.side-row').filter({hasText:'v1'}).getByRole('button').click();
  await page.getByRole('button',{name:'查看此版'}).click();
  await assertVersion('v1');
  if(confirmExport) {
    const target=path.join(testRoot,'从旧版导出的分镜.md');
    await app.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},target);
    await page.getByRole('button',{name:'导出稿件'}).click();
    await page.getByText('文件已保存。',{exact:true}).waitFor();
    const output=await readFile(target,'utf8');
    assert.match(output,new RegExp(data.artifacts[0].receipt.id));
    await page.getByText('文件已保存。',{exact:true}).waitFor({state:'hidden'});
    const renamed=path.join(testRoot,'从旧版导出的分镜 (2).md');
    await app.evaluate(({dialog},{target,renamed})=>{
      globalThis.markdownPrompts=[];
      dialog.showSaveDialog=async (_window,settings)=>{
        globalThis.markdownPrompts.push(settings);
        return {canceled:false,filePath:globalThis.markdownPrompts.length===1?target:renamed};
      };
    },{target,renamed});
    await page.getByRole('button',{name:'导出稿件'}).click();
    for(let retry=0;retry<60&&await app.evaluate(()=>globalThis.markdownPrompts.length)<2;retry++)await sleep(80);
    const markdownPrompts=await app.evaluate(()=>globalThis.markdownPrompts);
    assert.equal(markdownPrompts.length,2,'Same-name Markdown should reopen Save As');
    assert.equal(path.normalize(markdownPrompts[1].defaultPath),renamed);
    await page.getByText('文件已保存。',{exact:true}).waitFor();
    assert.equal(await readFile(renamed,'utf8'),output);
    assert.equal(await readFile(target,'utf8'),output);
    if (testHistoryNavigation) {
      await page.evaluate(()=>{location.hash='history?bot=media';});
      await page.getByRole('searchbox',{name:'搜索会话或项目'}).fill(data.title);
      const link=page.locator('.history-list a').filter({hasText:data.title});
      await link.waitFor();
      assert.equal(await link.getAttribute('href'),'#chat/'+room.id);
      await page.evaluate(()=>{location.hash='library';});
      const groups=await api('/api/library');
      const group=groups.find(row=>row.versions.some(version=>version.id===first));
      assert.ok(group);
      await page.getByRole('link',{name:'查看 '+group.title+' 的版本'}).click();
      await page.locator('.collection-version[href="#chat/'+room.id+'?artifact='+first+'"]').click();
      await assertVersion('v1');
      historyNavigation=true;
    }
    if (testReceipts) {
      await page.evaluate(()=>{location.hash='manage/receipts';});
      await page.getByRole('heading',{name:'运行回执',exact:true}).waitFor();
      const category=data.simulation?'simulation':'work';
      await page.getByRole('combobox',{name:'任务类型'}).selectOption(category);
      await page.getByRole('combobox',{name:'统计周期'}).selectOption('all');
      const receipts=await api('/api/receipts?category='+category+'&days=all');
      const known=receipts.rows.filter(row=>row.conversation===room.id&&row.delivered);
      assert.equal(known.length,2);
      assert.equal(known.every(row=>row.usage.status==='legacy'),true);
      await page.getByText('旧版口径',{exact:true}).first().waitFor();
      receiptNavigation=true;
    }
    if (testHostRestart) {
      await restartHost(api,page,room.id,[first,second]);
      await restartHost(api,page,room.id,[first,second]);
    }
  }
  return {room:room.id,artifacts:[first,second],workbenchProject:data.project};
}

async function workspaceCleanup(data,exportedFile,expectedDigest) {
  const started=performance.now();
  const backup=path.join(testRoot,'有留存期的备份');
  const restored=path.join(testRoot,'期限内还原');
  const until=new Date(Date.now()+3600000).toISOString();
  const maintenance=async (...args)=>JSON.parse((await node([archiveTool,...args])).stdout);
  const saved=await maintenance('backup',data,backup,'--retain-until',until);
  assert.equal(saved.retainUntil,until);
  assert.equal((await maintenance('verify',backup)).safeToRestore,true);
  await maintenance('restore',backup,restored);
  await access(path.join(restored,'hyper-bot.sqlite'));

  const oldTool=earlierPackaged?path.join(oldSource,'resources/app/scripts/workspace.mjs'):null;
  if (oldTool) await node([oldTool,'verify',backupDir]);
  await assert.rejects(node([archiveTool,'purge-expired',backup]),error=>error.stderr.includes('已经到期'));

  // Simulate expiry by backdating this fixture's manifest, without changing the system clock.
  const manifestFile=path.join(backup,'manifest.json');
  const retained=JSON.parse(await readFile(manifestFile,'utf8'));
  retained.createdAt='2026-01-01T00:00:00.000Z';
  retained.retainUntil='2026-01-02T00:00:00.000Z';
  await writeFile(manifestFile,JSON.stringify(retained),'utf8');
  const ended=await maintenance('verify',backup);
  assert.equal(ended.retentionEnded,true);
  assert.equal(ended.safeToRestore,false);
  const rejectedRestore=path.join(testRoot,'期限结束后不能还原');
  await assert.rejects(node([archiveTool,'restore',backup,rejectedRestore]),
    error=>error.stderr.includes('留存期限已结束'));
  await assert.rejects(access(rejectedRestore),{code:'ENOENT'});
  let rollbackRetention=null;
  if (oldTool) {
    await assert.rejects(node([oldTool,'restore',backup,rejectedRestore]),error=>{
      if (error.stderr.includes('留存期限已结束')) rollbackRetention='cutoff';
      else if (error.stderr.includes('hyper-bot-workspace/1')&&error.stderr.includes('format')) rollbackRetention='format-block';
      return rollbackRetention!==null;
    });
    await assert.rejects(access(rejectedRestore),{code:'ENOENT'});
  }
  const removal=await maintenance('purge-expired',backup);
  await access(backup);
  assert.equal((await maintenance('purge-expired',backup,'--confirm',removal.confirmation)).status,'removed');
  await assert.rejects(access(backup),{code:'ENOENT'});

  const preview=await maintenance('retire',data);
  await access(path.join(data,'hyper-bot.sqlite'));
  const removed=await maintenance('retire',data,'--confirm',preview.confirmation);
  assert.equal(removed.status,'removed');
  await assert.rejects(access(data),{code:'ENOENT'});
  assert.equal(createHash('sha256').update(await readFile(exportedFile)).digest('hex'),expectedDigest);
  assert.equal((await maintenance('verify',backupDir)).safeToRestore,true);
  return {backupExpiry:true,restoredBeforeExpiry:true,expiredRestoreRefused:true,
    rollbackRetention,purgedBackup:true,removedWorkspace:true,
    retainedBackupAndExport:true,removedWorkspaceFiles:removed.files,
    verificationMs:Math.round(performance.now()-started)};
}

async function retirementRound() {
  const started=performance.now();
  const data=path.join(testRoot,'停用演练工作区');
  const outside=path.join(testRoot,'外部成果');
  await mkdir(outside);
  await node([archiveTool,'restore',backupDir,data]);
  const target=path.join(outside,'自媒体口播历史成果.zip');
  const renamed=path.join(outside,'自媒体口播历史成果 (2).zip');
  const declined=path.join(outside,'取消后应为空.zip');
  const withdrawn=path.join(outside,'授权结束后应为空.zip');
  const original=await session(data,false,async({app,page,api,workspace})=>{
    const owner=workspace.conversations.find(room=>room.botId==='media');
    assert.ok(workspace.conversations.some(room=>room.botId==='brief'));
    const room=await api('/api/rooms/'+owner.id);
    assert.equal(room.artifacts.length,2);
    const bot=workspace.bots.find(bot=>bot.id===owner.botId&&bot.revision===owner.revision);
    assert.ok(bot.blocked);
    const card=page.locator('.manage-card').filter({
      has:page.getByRole('heading',{name:bot.name+' r'+bot.revision,exact:true})
    });
    await page.locator('#workspace-nav').getByRole('link',{name:'维护中心',exact:true}).click();
    await card.getByRole('button',{name:'停用此版'}).click();
    await card.getByText('已停用',{exact:true}).waitFor();
    await card.getByText('2 份可导出',{exact:true}).waitFor();
    const button=card.getByRole('button',{name:'导出历史成果'});
    await app.evaluate(({dialog},filePath)=>{
      dialog.showSaveDialog=async (_window,options)=>{
        if (!options.defaultPath.endsWith('-历史成果.zip')) throw new Error('Missing ZIP filename');
        return {canceled:true,filePath};
      };
    },declined);
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/workspace')),button.click()]);
    await assert.rejects(readFile(declined),{code:'ENOENT'});

    await app.evaluate(({dialog},filePath)=>{
      dialog.showSaveDialog=async()=>({canceled:false,filePath});
    },target);
    await button.click();
    await page.getByText('已导出 2 份历史成果。',{exact:true}).waitFor();
    const kept=await readFile(target);
    await page.getByText('已导出 2 份历史成果。',{exact:true}).waitFor({state:'hidden'});
    await app.evaluate(({dialog},{target,renamed})=>{
      globalThis.historyPrompts=[];
      dialog.showSaveDialog=async (_window,settings)=>{
        globalThis.historyPrompts.push(settings);
        return {canceled:false,filePath:globalThis.historyPrompts.length===1?target:renamed};
      };
    },{target,renamed});
    await button.click();
    await page.getByText('已导出 2 份历史成果。',{exact:true}).waitFor();
    const historyPrompts=await app.evaluate(()=>globalThis.historyPrompts);
    assert.equal(historyPrompts.length,2);
    assert.equal(path.normalize(historyPrompts[1].defaultPath),renamed);
    assert.deepEqual(await readFile(target),kept);

    const paths=[...new Set(room.artifacts.map(record=>record.materialIds[0]))]
      .map(id=>'/api/rooms/'+room.id+'/materials/'+id+'/revoke');
    await app.evaluate(({dialog},filePath)=>{
      globalThis.finishQaExport=null;
      dialog.showSaveDialog=()=>new Promise(resolve=>{
        globalThis.finishQaExport=()=>resolve({canceled:false,filePath});
      });
    },withdrawn);
    await button.click();
    for (let i=0;i<70 && !await app.evaluate(()=>!!globalThis.finishQaExport);i++) await sleep(75);
    assert.ok(await app.evaluate(()=>!!globalThis.finishQaExport));
    for (const route of paths) assert.equal((await windowRequest(page,route,{confirmed:true})).status,202);
    await app.evaluate(()=>globalThis.finishQaExport());
    await page.getByText('此版本暂无授权有效的成果可导出。',{exact:true}).waitFor();
    await card.getByText('0 份可导出，2 个仅保留版本记录',{exact:true}).waitFor();
    assert.equal(await button.isDisabled(),true);
    await assert.rejects(readFile(withdrawn),{code:'ENOENT'});
    assert.deepEqual(await readFile(target),kept);
    await card.getByRole('link',{name:'查看此版会话'}).click();
    await page.locator('.history-list a[href="#chat/'+room.id+'"]').click();
    await page.getByRole('heading',{name:room.title,exact:true}).waitFor();
    await page.getByText('此 Bot 版本已停用。历史仍可查看，授权有效的成果可导出。',{exact:true}).waitFor();
    return {room,bot,sha256:createHash('sha256').update(kept).digest('hex')};
  });

  await assert.rejects(readFile(path.join(data,'host.lock')),{code:'ENOENT'});
  const extracted=path.join(outside,'解压后独立阅读');
  await mkdir(extracted);
  const tar=path.join(process.env.SystemRoot ?? 'C:/Windows','System32','tar.exe');
  await exec(tar,['-xf',renamed,'-C',extracted],{env:deviceEnv,timeout:18000,windowsHide:true});
  const index=await readFile(path.join(extracted,'打开成果.md'),'utf8');
  const manifest=JSON.parse(await readFile(path.join(extracted,'版本与来源.json'),'utf8'));
  assert.deepEqual(manifest.bot,{id:original.bot.id,name:original.bot.name,revision:original.bot.revision});
  assert.deepEqual(manifest.counts,{conversations:1,exported:2,unavailable:0});
  const expected=[...original.room.artifacts].reverse();
  assert.deepEqual(manifest.versions.map(version=>version.id),expected.map(record=>record.id));
  for (const [position,version] of manifest.versions.entries()) {
    const bytes=await readFile(path.join(extracted,version.file));
    assert.ok(bytes.toString('utf8').startsWith('# '+expected[position].result.title));
    assert.equal(version.workbench.id,expected[position].receipt.id);
    assert.deepEqual(version.sources.map(source=>source.id),expected[position].materialIds);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),version.sha256);
    assert.ok(index.includes(version.file));
  }
  const cleanup=testWorkspaceCleanup?await workspaceCleanup(data,target,original.sha256):null;
  return {versions:manifest.versions.length,cancelled:true,collisionPreserved:true,collisionRenamed:true,withdrawalRechecked:true,
    extractedWithWindowsTarAfterHostExit:true,archiveSha256:original.sha256,
    ...(cleanup?{cleanup}:{}),verificationMs:Math.round(performance.now()-started)};
}

async function artifactBundleRound() {
  const data=path.join(testRoot,'单版成果包工作区');
  const output=path.join(testRoot,'离线读审文件');
  await mkdir(output);
  await node([archiveTool,'restore',backupDir,data]);
  const occupied=path.join(output,'同名文件.zip');
  const saved=path.join(output,'选择新文件名.zip');
  const cancelled=path.join(output,'取消后不得创建.zip');
  const revoked=path.join(output,'撤回后不得创建.zip');
  const original='同名文件原始内容';
  await writeFile(occupied,original);
  const manifests=['来源交接.json','来源交接 (2).json','来源交接 (3).json'].map(name=>path.join(output,name));
  for (const file of manifests.slice(0,2))await writeFile(file,original);
  const record=await session(data,false,async({app,page,api,workspace})=>{
    const owner=workspace.conversations.find(item=>item.botId==='media');
    const room=await api('/api/rooms/'+owner.id);
    const [first,second]=room.artifacts;
    const route=artifact=>'#chat/'+room.id+'?artifact='+artifact.id;
    const options=page.getByRole('button',{name:'导出选项',exact:true});
    const selectExport=async name=>{
      await options.click();
      await page.getByRole('dialog',{name:'导出成果',exact:true}).getByRole('button',{name,exact:true}).click();
    };
    const selectBundle=()=>selectExport('稿件与来源 ZIP');
    const pickerReady=async()=>{
      for(let attempt=0;attempt<60;attempt++){
        if(await app.evaluate(()=>!!globalThis.finishArtifactPicker)) return;
        await sleep(80);
      }
      throw new Error('Expected the native artifact picker');
    };
    const choose=async artifact=>{
      await page.evaluate(hash=>{location.hash=hash;},route(artifact));
      await page.locator('.panel-subhead .version').getByText('v'+artifact.version,{exact:true}).waitFor();
    };
    const outside=new URL('/api/artifacts/'+first.id+'/export?format=bundle',page.url());
    assert.equal((await fetch(outside,{headers:{'X-Hyper-Bot':'1'},signal:AbortSignal.timeout(5000)})).status,403);
    await choose(first);

    await app.evaluate(({dialog},{occupied,saved})=>{
      globalThis.artifactPrompts=[];
      globalThis.finishArtifactPicker=null;
      dialog.showSaveDialog=async (_window,settings)=>{
        globalThis.artifactPrompts.push(settings);
        if(globalThis.artifactPrompts.length===1){
          return new Promise(resolve=>{globalThis.finishArtifactPicker=()=>resolve({canceled:false,filePath:occupied});});
        }
        return {canceled:false,filePath:saved};
      };
    },{occupied,saved});
    await selectBundle();
    await pickerReady();
    await choose(second);
    await app.evaluate(()=>globalThis.finishArtifactPicker());
    await page.getByText('成果包已保存。',{exact:true}).waitFor();
    const prompts=await app.evaluate(()=>globalThis.artifactPrompts);
    assert.equal(prompts.length,2);
    assert.match(prompts[0].defaultPath,/-v1-成果包\.zip$/);
    assert.equal(path.basename(prompts[1].defaultPath),'同名文件 (2).zip');
    assert.equal(path.dirname(prompts[1].defaultPath),output);
    assert.equal(await readFile(occupied,'utf8'),original);

    await choose(first);
    await app.evaluate(({dialog},{occupied,cancelled})=>{
      globalThis.cancelPickerCount=0;
      dialog.showSaveDialog=async ()=>++globalThis.cancelPickerCount===1?
        {canceled:false,filePath:occupied}:{canceled:true,filePath:cancelled};
    },{occupied,cancelled});
    await selectBundle();
    for(let attempt=0;attempt<60&&await app.evaluate(()=>globalThis.cancelPickerCount)<2;attempt++)await sleep(80);
    assert.equal(await app.evaluate(()=>globalThis.cancelPickerCount),2);
    await page.locator('button[aria-label="导出选项"]:enabled').waitFor();
    await assert.rejects(access(cancelled),{code:'ENOENT'});
    assert.equal(await readFile(occupied,'utf8'),original);

    await app.evaluate(({dialog},paths)=>{
      globalThis.manifestPrompts=[];
      dialog.showSaveDialog=async (_window,settings)=>{
        const index=globalThis.manifestPrompts.push(settings)-1;
        if(index>=paths.length)throw new Error('Unexpected manifest dialog');
        return {canceled:false,filePath:paths[index]};
      };
    },manifests);
    await selectExport('仅版本与来源 JSON');
    await page.getByText('文件已保存。',{exact:true}).waitFor();
    const manifestPrompts=await app.evaluate(()=>globalThis.manifestPrompts);
    assert.equal(manifestPrompts.length,3);
    assert.deepEqual(manifestPrompts.slice(1).map(item=>path.normalize(item.defaultPath)),manifests.slice(1));
    for(const file of manifests.slice(0,2))assert.equal(await readFile(file,'utf8'),original);
    const standalone=JSON.parse(await readFile(manifests[2],'utf8'));
    assert.equal(standalone.id,first.id);
    assert.equal(standalone.version,1);
    assert.equal(standalone.workbench.id,first.receipt.id);

    await app.evaluate(({dialog},revoked)=>{
      globalThis.finishArtifactPicker=null;
      dialog.showSaveDialog=()=>new Promise(resolve=>{
        globalThis.finishArtifactPicker=()=>resolve({canceled:false,filePath:revoked});
      });
    },revoked);
    await selectBundle();
    await pickerReady();
    assert.equal((await windowRequest(page,'/api/rooms/'+room.id+'/materials/'+first.materialIds[0]+'/revoke',{confirmed:true})).status,202);
    await app.evaluate(()=>globalThis.finishArtifactPicker());
    await page.getByText('此稿件的材料授权已结束。',{exact:true}).waitFor();
    await assert.rejects(access(revoked),{code:'ENOENT'});
    return first;
  });
  await assert.rejects(access(path.join(data,'host.lock')),{code:'ENOENT'});
  const extracted=path.join(output,'离线读取');
  await mkdir(extracted);
  const tar=path.join(process.env.SystemRoot??'C:/Windows','System32','tar.exe');
  await exec(tar,['-xf',saved,'-C',extracted],{env:deviceEnv,timeout:18000,windowsHide:true});
  const manifest=JSON.parse(await readFile(path.join(extracted,'版本与来源.json'),'utf8'));
  assert.equal(manifest.id,record.id);
  assert.equal(manifest.version,1);
  assert.equal(manifest.markdownFile,'稿件.md');
  assert.equal(manifest.workbench.id,record.receipt.id);
  assert.ok(manifest.citations.length>0);
  const markdown=await readFile(path.join(extracted,manifest.markdownFile));
  assert.equal(createHash('sha256').update(markdown).digest('hex'),manifest.markdownSha256);
  return {openedWhenHostExited:true,selectionPinned:true,collisionRenamed:true,collisionCancelled:true,
    withdrawalRechecked:true,manifestCollisionRenamed:true,markdownSha256:manifest.markdownSha256,citations:manifest.citations.length};
}

async function hostFailureRound() {
  const data=path.join(testRoot,'本机服务首次重启失败');
  await node([archiveTool,'restore',backupDir,data]);
  const marker=path.join(data,'host.lock');
  return session(data,false,async({app,page,api,workspace})=>{
    const room=workspace.conversations.find(item=>item.botId==='media');
    const before=await api('/api/rooms/'+room.id);
    const [first]=before.artifacts;
    const route='#chat/'+room.id+'?artifact='+first.id;
    await page.evaluate(hash=>{location.hash=hash;},route);
    const version=page.locator('.panel-subhead .version').getByText('v1',{exact:true});
    await version.waitFor();
    const url=page.url();
    const banner=page.locator('.connection-banner');
    const retry=banner.getByRole('button',{name:'重连',exact:true});
    await app.evaluate(()=>{
      const childProcess=process.getBuiltinModule('node:child_process');
      const originalFork=childProcess.fork;
      globalThis.qaRestarts=[];
      childProcess.fork=function(filename,...args) {
        const child=originalFork.call(this,filename,...args);
        if(filename.endsWith('desktop\\server.mjs')){
          const attempt={pid:child.pid,status:'starting',finished:false};
          globalThis.qaRestarts.push(attempt);
          child.on('message',packet=>{
            if(packet.status==='ready')attempt.status='ready';
            if(packet.status==='error'){
              attempt.status='error';
              attempt.error=packet.message;
            }
          });
          child.once('close',()=>{attempt.finished=true;});
        }
        return child;
      };
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    });
    const attempts=()=>app.evaluate(()=>globalThis.qaRestarts);
    async function waitForAttempt(match,label,timeout=28000) {
      const deadline=Date.now()+timeout;
      while(Date.now()<deadline){
        const rows=await attempts();
        if(match(rows))return rows;
        await sleep(85);
      }
      throw new Error(label);
    }
    const failed=attempt=>attempt?.status==='error'&&attempt.finished;
    async function blockRestart() {
      const holder=await readFile(marker,'utf8');
      const pretendOwner=JSON.stringify({pid:process.pid,nonce:'isolated-retry-fixture'});
      await writeFile(marker,pretendOwner);
      process.kill(JSON.parse(holder).pid);
      return async ()=>{
        if(await readFile(marker,'utf8').catch(()=>null)===pretendOwner)await writeFile(marker,holder);
      };
    }
    async function verifyRecovery() {
      await banner.waitFor({state:'hidden',timeout:18000});
      assert.equal(page.url(),url);
      await version.waitFor();
      const after=await api('/api/rooms/'+room.id);
      assert.deepEqual(after.artifacts.map(item=>item.id),before.artifacts.map(item=>item.id));
      assert.deepEqual(after.runs.map(item=>item.id),before.runs.map(item=>item.id));
      return after;
    }

    let release=await blockRestart();
    try {
      const [refused]=await waitForAttempt(rows=>failed(rows[0]),'Expected an actual Windows host start refusal');
      assert.match(refused.error,/已有 Hyper Bot 进程/);
      await banner.waitFor();
    } finally { await release(); }
    const recovered=await waitForAttempt(rows=>rows.some(item=>item.status==='ready'),
      'The original loopback service did not retry after a temporary failure',10000);
    assert.equal(recovered.filter(item=>item.status==='ready').length,1);
    await verifyRecovery();

    const offset=recovered.length;
    release=await blockRestart();
    const draft='断线后继续编辑的合成改稿说明。';
    const input=page.getByRole('textbox',{name:'给自媒体口播发消息'});
    let exhausted;
    try {
      await banner.waitFor();
      await input.fill(draft);
      exhausted=await waitForAttempt(rows=>rows.slice(offset).filter(failed).length>=4,
        'Automatic host restart did not reach its bounded failure path');
      assert.equal(exhausted.filter(item=>item.status==='ready').length,1);
      assert.ok(exhausted.slice(offset).every(item=>/已有 Hyper Bot 进程/.test(item.error)));
    } finally { await release(); }

    const screenshots=process.env.HYPER_BOT_TEST_SCREENSHOTS;
    if(screenshots)await mkdir(screenshots,{recursive:true});
    for(const width of [1440,1024,768,390,320]){
      await page.setViewportSize({width,height:width<=390?844:900});
      await page.emulateMedia({reducedMotion:width===320?'reduce':'no-preference'});
      const bounds=await banner.boundingBox();
      assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      const tap=await retry.boundingBox();
      if(width<=390)assert.ok(tap.height>=44&&tap.width>=44);
      assert.equal(await banner.locator('.status-in').evaluate(el=>getComputedStyle(el).animationDuration),width===320?'0s':'0.18s');
      if(screenshots && (width===1440||width===390))await page.screenshot({
        path:path.join(screenshots,width===1440?'桌面-本机服务重连.png':'手机-本机服务重连.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:1440,height:900});
    const reconnected=page.waitForResponse(response=>response.status()===200 &&
      new URL(response.url()).pathname==='/api/events',{timeout:18000});
    await retry.focus();
    await page.keyboard.press('Enter');
    await waitForAttempt(rows=>rows.slice(exhausted.length).some(item=>item.status==='ready'),
      'Reconnect did not start the local service');
    await reconnected;
    await verifyRecovery();
    await page.waitForFunction(()=>document.activeElement?.id==='message');
    assert.equal((await attempts()).length,exhausted.length+1);
    assert.equal(await input.inputValue(),draft);
    const limit=Date.now()+12000;
    let stored;
    do {
      stored=(await api('/api/rooms/'+room.id)).draft.text;
      if(stored===draft)break;
      await sleep(90);
    } while(Date.now()<limit);
    assert.equal(stored,draft);

    const hidden=page.waitForEvent('close',{timeout:10000});
    await page.close();
    await hidden;
    const nextWindow=app.waitForEvent('window',{timeout:16000});
    await app.evaluate(({app})=>app.emit('second-instance'));
    const reopened=await nextWindow;
    assert.ok(reopened,'The desktop window should reopen without restarting the live host');
    await reopened.waitForURL(url);
    await reopened.locator('.panel-subhead .version').getByText('v1',{exact:true}).waitFor();
    assert.equal(await reopened.getByRole('textbox',{name:'给自媒体口播发消息'}).inputValue(),draft);
    assert.equal((await attempts()).length,exhausted.length+1);
    return {firstAttemptRefused:true,automaticRecovery:true,explicitRecovery:true,
      attemptedBeforeManual:exhausted.length-offset,viewports:[1440,1024,768,390,320],
      sameOrigin:true,eventStreamRecovered:true,savedOfflineDraft:true,restoredKeyboardFocus:true,reopenedWithoutHostRestart:true};
  });
}

const previous=await session(upgrade,true,context=>history(context,false));
const deployed=await session(upgrade,false,context=>history(context,true));
const rolledBack=await session(upgrade,true,context=>history(context,false));
assert.deepEqual(deployed,previous);
assert.deepEqual(rolledBack,previous);
const retirement=testHistoryExport?await retirementRound():null;
const artifactBundle=testArtifactBundle?await artifactBundleRound():null;
const hostStartRetry=testHostStartRetry?await hostFailureRound():null;
console.log(JSON.stringify({clean,upgrade,previous,deployed,rolledBack,offlineExportAndCollision:true,
  ...(executableIdentity?{executableIdentity}:{}),
  ...(testHostRestart?{hostRestarts}:{}),...(testWindowAccess?{reconnectedEventStreams}:{}),
  ...(testHistoryNavigation?{historyNavigation}:{}),
  ...(testReceipts?{receiptNavigation}:{}),...(retirement?{retirement}:{}),...(artifactBundle?{artifactBundle}:{}),...(hostStartRetry?{hostStartRetry}:{})}));

