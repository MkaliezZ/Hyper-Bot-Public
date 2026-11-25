import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { open, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startHost } from './host.mjs';
import { desktopCredentialStore } from './credentials.mjs';
import { readRuntimeInstallations, runtimeId } from './runtime-installations.mjs';
import { workspaceDirectory } from '../server/config.mjs';
import { botKey, id, Problem } from '../server/contracts.mjs';
import { windowHeader } from '../server/window-session.mjs';

app.setName('Hyper Bot');
app.setAppUserModelId('com.hyperdimension.hyperbot');
const data=workspaceDirectory();
const desktopData=path.join(data,'desktop');
mkdirSync(desktopData,{recursive:true});
app.setPath('userData',desktopData);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, backend, rendererSession, tray, lastRoute='/', closed=false, reopenWhenReady=false;
  const dev=process.argv.includes('--dev');
  const restartDelays=[850,2000,4500];
  let restartTimer,restarting,failedRestarts=0,credentials,changingCredential=false;
  let runtimeSelection,changingRuntime=false;
  const iconPath=fileURLToPath(new URL('../public/media/mark.png',import.meta.url));

  function ownsFrame(contents,frame,origin) {
    return !!contents && !!frame && !contents.isDestroyed() && contents.mainFrame===frame &&
      frame.url.startsWith(origin+'/');
  }

  function bindRendererSession() {
    rendererSession=session.fromPartition('hyper-bot-window');
    rendererSession.setPermissionRequestHandler((_contents,_permission,respond)=>respond(false));
    rendererSession.webRequest.onBeforeSendHeaders({urls:['http://127.0.0.1/*']},(request,reply)=>{
      const service=backend, target=new URL(request.url);
      if (target.origin!==service?.origin || !target.pathname.startsWith('/api/')) return reply({});
      const contents=window?.webContents;
      if (!service.active || request.webContentsId!==contents?.id ||
          !ownsFrame(contents,request.frame,service.origin) ||
          !['xhr','other'].includes(request.resourceType)) {
        return reply({cancel:true});
      }
      const headers=Object.fromEntries(Object.entries(request.requestHeaders).filter(([name])=>name.toLowerCase()!==windowHeader));
      reply({requestHeaders:{...headers,[windowHeader]:service.windowKey}});
    });
  }

  function showWindow() {
    if (backend && !backend.active) void restartLocalHost(true);
    if (window && !window.isDestroyed()) {
      if(window.isMinimized())window.restore();
      window.focus();
      return;
    }
    if (!backend?.active) {reopenWhenReady=true;return;}
    reopenWhenReady=false;
    const opened=new BrowserWindow({width:1440,height:900,minWidth:420,minHeight:620,title:'Hyper Bot',
      backgroundColor:'#ffffff',icon:iconPath,show:false,
      webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,session:rendererSession,
        preload:fileURLToPath(new URL('./preload.cjs',import.meta.url))}});
    window=opened;
    opened.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    opened.webContents.on('will-navigate',(event,url)=>{
      if (!backend?.active || new URL(url).origin!==backend.origin) event.preventDefault();
    });
    const rememberRoute=(_,url)=>{
      const target=new URL(url);
      if (target.origin===backend?.origin) lastRoute=target.pathname+target.hash;
    };
    opened.webContents.on('did-navigate',rememberRoute);
    opened.webContents.on('did-navigate-in-page',rememberRoute);
    opened.once('closed',()=>{if(window===opened)window=null;});
    opened.once('ready-to-show',()=>{if(!opened.isDestroyed())opened.show();});
    void opened.loadURL(backend.origin+lastRoute);
  }

  function ownsWindowRequest(event) {
    const contents=window?.webContents;
    return event.sender===contents && ownsFrame(contents,event.senderFrame,backend?.origin);
  }

  function checkExportSender(event) {
    if (!backend?.active || !ownsWindowRequest(event)) throw new Error('导出请求来源无效。');
  }

  function exportRoute(event,route) {
    const group=/^\/w\/([^/]+)\/$/.exec(new URL(event.senderFrame.url).pathname);
    return group?'/api/v1/workspaces/'+id.parse(group[1])+route:'/api'+route;
  }

  async function fetchExport(route,timeout=5000) {
    const service=backend;
    if (!service?.active) throw new Error('本机服务正在重连。请稍后重新导出。');
    const response=await fetch(service.origin+route,{redirect:'error',signal:AbortSignal.timeout(timeout),
      headers:{'X-Hyper-Bot':'1',[windowHeader]:service.windowKey}});
    if (backend!==service || !service.active) {
      await response.body?.cancel();
      throw new Error('本机服务正在重连。请稍后重新导出。');
    }
    if (response.status===410) return null;
    if (!response.ok) {
      const payload=await response.json();
      throw new Error(payload.error || '本机成果暂无法导出。');
    }
    return response;
  }

  async function saveNewFile(filename,content) {
    let file;
    try {
      file=await open(filename,'wx');
      await file.writeFile(content);
      await file.close();
      return 'saved';
    } catch(error) {
      if (!file && error.code==='EEXIST') return 'exists';
      if (file) {
        await file.close().catch(()=>{});
        await unlink(filename).catch(()=>{});
      }
      throw new Error('目标文件无法写入。');
    }
  }

  async function saveExport(event, title, filename, filter, readExport) {
    let defaultPath=filename, collision=null, suffix=2;
    for (;;) {
      const result=await dialog.showSaveDialog(window,{
        title:collision?'文件已存在，请另存':title,defaultPath,filters:[filter]
      });
      if (result.canceled || !result.filePath) return {status:'cancelled'};
      checkExportSender(event);
      const data=await readExport();
      if (!data) return {status:'material-ended'};
      const {content,...details}=data;
      checkExportSender(event);
      const status=await saveNewFile(result.filePath,content);
      if (status!=='exists') return {status,...details};
      if (!collision || path.normalize(result.filePath)!==path.normalize(defaultPath)) {
        collision=path.parse(result.filePath);
        suffix=2;
      }
      defaultPath=path.join(collision.dir,collision.name+' ('+suffix+')'+collision.ext);
      suffix++;
    }
  }

  async function saveArtifact(event,artifactId,format='markdown') {
    checkExportSender(event);
    const formats={
      markdown:{title:'导出口播或简报',name:'Markdown',extension:'md',suffix:'.md'},
      manifest:{title:'导出版本与来源',name:'版本与来源',extension:'json',suffix:'-来源.json'},
      bundle:{title:'导出成果包',name:'ZIP 压缩文件',extension:'zip',suffix:'-成果包.zip'}
    };
    if (typeof format!=='string' || !Object.hasOwn(formats,format)) throw new Error('请选择可用的导出格式。');
    const choice=formats[format];
    const route=exportRoute(event,'/artifacts/'+id.parse(artifactId)+'/export');
    const before=await fetchExport(route+'?format=filename');
    if (!before) return 'material-ended';
    const {filename}=await before.json();
    const packed=format==='bundle';
    const result=await saveExport(event,choice.title,filename.replace(/\.md$/,choice.suffix),
      {name:choice.name,extensions:[choice.extension]},async()=>{
        const after=await fetchExport(route+(packed?'?format=bundle':''),packed?30000:5000);
        if (!after) return null;
        if (packed) return {content:Buffer.from(await after.arrayBuffer())};
        const artifact=await after.json();
        return {content:format==='manifest'?JSON.stringify(artifact.manifest,null,2):artifact.markdown};
      });
    return result.status;
  }

  async function saveBotHistory(event,botId,revision) {
    checkExportSender(event);
    if (!Number.isSafeInteger(revision) || revision<1) throw new Error('Bot 版本无效。');
    const route=exportRoute(event,'/bots/'+botKey.parse(botId)+'/'+revision+'/history-export');
    const before=await fetchExport(route+'?format=summary');
    if (!before) return {status:'material-ended'};
    const {filename}=await before.json();
    return saveExport(event,'导出 Bot 历史成果',filename,{name:'ZIP 压缩文件',extensions:['zip']},async()=>{
      const after=await fetchExport(route,30000);
      return after?{content:Buffer.from(await after.arrayBuffer()),count:Number(after.headers.get('X-Hyper-Bot-Exported'))}:null;
    });
  }

  const visibleSelection=choice=>Object.fromEntries(Object.entries(choice).map(([field,value])=>
    [field,value.split(/[\\/]/).filter(Boolean).slice(field==='root'?-2:-3).join(' / ')]));
  const localRuntimeNames={workbench:'Self Media Workbench',hermes:'Hermes ACP'};

  function beginRuntimeSelection(event,id) {
    if (!ownsWindowRequest(event) || process.platform!=='win32') throw new Error('组件配置请求来源无效。');
    if (changingRuntime) throw new Error('正在应用本机组件设置。');
    id=runtimeId.parse(id);
    const choice={...readRuntimeInstallations(data).overrides[id]};
    runtimeSelection={id,ticket:randomUUID(),choice};
    return {ticket:runtimeSelection.ticket,fields:visibleSelection(choice)};
  }

  function currentRuntimeSelection(event,ticket) {
    if (!ownsWindowRequest(event) || !runtimeSelection || runtimeSelection.ticket!==ticket) {
      throw new Error('组件配置已关闭或来源无效。');
    }
    return runtimeSelection;
  }

  async function pickRuntimePath(event,ticket,field) {
    const selection=currentRuntimeSelection(event,ticket);
    if (changingRuntime || !['root','python'].includes(field)) throw new Error('此组件配置无法更改。');
    const folder=field==='root';
    const result=await dialog.showOpenDialog(window,{
      title:folder?'选择 '+localRuntimeNames[selection.id]+' 安装目录':'选择此组件使用的 Python',
      defaultPath:selection.choice[field],
      properties:folder?['openDirectory']:['openFile'],
      ...(folder?{}:{filters:[{name:'Python 可执行文件',extensions:['exe']}]})
    });
    currentRuntimeSelection(event,ticket);
    if (!result.canceled && result.filePaths[0]) selection.choice[field]=result.filePaths[0];
    return visibleSelection(selection.choice);
  }

  async function applyRuntimeSelection(event,ticket,mode) {
    const staged=currentRuntimeSelection(event,ticket);
    if (changingRuntime || changingCredential || !backend?.active) return {ok:false,message:'本机设置暂时无法更新，请稍后重试。'};
    if (!['selected','automatic'].includes(mode)) return {ok:false,message:'组件设置方式无效。'};
    const selection=mode==='automatic'?null:staged.choice;
    if (selection && (!selection.root || !selection.python)) return {ok:false,message:'请选择安装目录和 Python。'};
    changingRuntime=true;
    try {
      const service=backend;
      await service.changeRuntime({id:staged.id,selection});
      await service.close();
      const ready=await restartLocalHost(true);
      return ready.ok?{ok:true}:{ok:false,saved:true,message:'组件设置已保存。请在原窗口重连本机服务。'};
    } catch(error) {
      return {ok:false,message:error instanceof Problem?error.message:'本机组件设置暂时无法更新。'};
    } finally {changingRuntime=false;}
  }

  async function setProviderCredential(event,value) {
    if (!ownsWindowRequest(event)) throw new Error('凭据请求来源无效。');
    if (!backend?.active) return {ok:false,message:'本机服务正在重连。请稍后重试。'};
    if (changingCredential || changingRuntime) return {ok:false,message:'正在更新本机设置。'};
    changingCredential=true;
    try {
      const change=credentials.change(value);
      return {ok:true,provider:await backend.changeCredential(change)};
    } catch(error) {
      return {ok:false,message:error instanceof Problem?error.message:'本机凭据暂时无法更新。'};
    } finally {changingCredential=false;}
  }

  function restartLocalHost(userInitiated=false) {
    if (closed || !backend) return Promise.resolve({ok:false,message:'本机服务暂未启动。'});
    if (backend.active) return Promise.resolve({ok:true});
    if (userInitiated) failedRestarts=0;
    if (restarting) return restarting;
    clearTimeout(restartTimer);
    const port=Number(new URL(backend.origin).port);
    restarting=startHost(dev,port,credentials.read()).then(async resumed=>{
      restarting=null;
      if (closed) {
        await resumed.close();
        return {ok:false,message:'正在退出 Hyper Bot。'};
      }
      backend=resumed;
      failedRestarts=0;
      monitor(resumed);
      if (reopenWhenReady) showWindow();
      return {ok:true};
    },error=>{
      restarting=null;
      if (!closed) {
        const delay=restartDelays[failedRestarts++];
        if (delay!==undefined) restartTimer=setTimeout(()=>void restartLocalHost(),delay);
        else console.error('Hyper Bot local service could not restart.');
      }
      return {ok:false,message:error?.status?error.message:'本机服务暂未启动。请重试。'};
    });
    return restarting;
  }

  function monitor(service) {
    void service.exited.then(()=>{
      if (backend===service && !closed) void restartLocalHost();
    });
  }

  app.on('second-instance',()=>{if(backend&&!closed)showWindow();});
  app.on('window-all-closed',()=>{ /* The local service and tray own the app lifetime. */ });
  app.on('before-quit',event=>{
    if (!backend || closed)return;
    event.preventDefault();
    closed=true;
    clearTimeout(restartTimer);
    tray?.destroy();
    void Promise.allSettled([backend.close(),restarting]).then(results=>{
      if (results.some(result=>result.status==='rejected')) process.exitCode=1;
    }).finally(()=>app.quit());
  });
  app.whenReady().then(async()=>{
    bindRendererSession();
    credentials=desktopCredentialStore(data,safeStorage,process.env.DEEPSEEK_API_KEY?.trim());
    backend=await startHost(dev,0,credentials.read());
    monitor(backend);
    console.log('Hyper Bot '+backend.origin);
    tray=new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Hyper Bot');
    tray.on('double-click',showWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'打开 Hyper Bot',click:showWindow},
      {label:'退出 Hyper Bot',click:()=>app.quit()}
    ]));
    ipcMain.handle('hyper-bot:reconnect',event=>{
      if (!ownsWindowRequest(event)) throw new Error('重连请求来源无效。');
      return restartLocalHost(true);
    });
    ipcMain.handle('hyper-bot:runtime-begin',beginRuntimeSelection);
    ipcMain.handle('hyper-bot:runtime-pick',pickRuntimePath);
    ipcMain.handle('hyper-bot:runtime-apply',applyRuntimeSelection);
    ipcMain.handle('hyper-bot:runtime-close',(event,ticket)=>{
      if (ownsWindowRequest(event) && runtimeSelection?.ticket===ticket) runtimeSelection=null;
    });
    ipcMain.handle('hyper-bot:credential',setProviderCredential);
    ipcMain.handle('hyper-bot:save',saveArtifact);
    ipcMain.handle('hyper-bot:save-history',saveBotHistory);
    showWindow();
  }).catch(error=>{
    dialog.showErrorBox('Hyper Bot 无法启动',error?.status ? error.message : '请构建前端并检查本机依赖。');
    app.quit();
  });
}

