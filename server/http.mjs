import http from 'node:http';
import {groupChat} from './group-chat.mjs';
import {downloadGroupFile,saveGroupFile} from './group-files.mjs';
import {chooseGroupFolder} from './group-picker.mjs';
import { teachingServices } from './teaching-trial.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { workspaceLock } from './workspace-lock.mjs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { Store, isLive } from './store.mjs';
import { Problem, botKey, id } from './contracts.mjs';
import { jsonBody } from './provider.mjs';
import { configFor,root } from './config.mjs';
import { HyperBot } from './application.mjs';
import { artifactArchive, artifactBundle, retiredBotArchive } from './export.mjs';
import { Workbench } from './workbench.mjs';
import { matchesWindowKey, validWindowKey, windowHeader } from './window-session.mjs';
import { personalWorkspace, WorkspaceGroups } from './workspace-groups.mjs';

const mediaTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.svg':'image/svg+xml','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp' };
function json(response, value, status = 200) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
}
function zipDownload(response,archive,extra={}) {
  const filename=encodeURIComponent(archive.filename).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16));
  response.writeHead(200,{'Content-Type':'application/zip','Cache-Control':'no-store',
    'Content-Length':archive.bytes.length,'Content-Disposition':"attachment; filename*=UTF-8''"+filename,...extra});
  response.end(archive.bytes);
}
function sendError(response,error) {
  if (response.headersSent) {response.destroy();return;}
  if (error instanceof ZodError) {
    const field=error.issues[0]?.path.join('.');
    json(response,{error:field?'字段 '+field+' 未通过校验。':'输入格式未通过校验。',code:'validation'},422);
  } else if(error instanceof Problem) json(response,{error:error.message,code:error.code},error.status);
  else {
    console.error('Hyper Bot request error:',error?.code ?? error?.name ?? 'error');
    json(response,{error:'服务器暂时无法处理此请求。请刷新后重试。',code:'server_error'},500);
  }
}

function events(response,store,streams) {
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});
  const update=version=>response.write('id: '+version+'\ndata: '+version+'\n\n');
  const unsub=store.onChange(update);
  const timer=setInterval(()=>response.write(': pulse\n\n'),13000);
  timer.unref();
  streams.add(response);
  response.once('close',()=>{clearInterval(timer);unsub();streams.delete(response);});
  update(store.read().version);
}

function apiMethod(request,response,url,host,streams,configuring) {
  const segments=url.pathname.split('/').slice(2).map(decodeURIComponent);
  const method=request.method;
  const [first,key,part,extra,leaf] = segments;
  const post=method==='POST', get=method==='GET';
  const app=host.app;
  const requireRuntime=()=>{
    if (app.runtimeChanging || configuring()) throw new Problem(503,'本机服务正在应用组件设置。','runtime_restarting');
  };
  const input=async()=>{
    const value=await jsonBody(request);
    requireRuntime();
    return value;
  };
  const registry=app.registry;
  const takeId = value=>id.parse(value);
  return (async()=>{
    requireRuntime();
    app.expire();
    if (get && first==='workspace' && !key) return json(response,{...app.index(),workspace:host.group});
    if(get&&first==='conversation-search'&&!key) return json(response,app.searchConversations((url.searchParams.get('q')??'').slice(0,100)));
    if (post && first==='bot-instances' && !key) return json(response,app.installBot(await input()));
    if (post && first==='bot-instances' && key==='remove-from-sidebar' && !part) {
      if(host.group.id!=='personal')throw new Problem(403,'只能从个人工作区侧栏移除 Bot。','workspace_scope');
      return json(response,app.removeSidebarBot(await input()));
    }
    if (first==='entity') {
      if (get && !key) return json(response,app.entityArchive());
      if (get && key==='sources' && !part) return json(response,app.entitySources());
      if (get && key==='candidates' && part && !extra) return json(response,app.entityCandidate(takeId(part)));
      if (post && key==='records' && !part) return json(response,app.saveEntity(await input()),201);
      if (post && key==='records' && part && extra==='revoke' && !leaf) {
        return json(response,app.revokeEntity(takeId(part),await input()));
      }
    }
    if (first==='memories') {
      if (get && !key) return json(response,app.memories());
      if (post && !key) return json(response,app.saveMemory(await input()),201);
      if (post && key && !extra && (!part||part==='revoke')) {
        return json(response,app.saveMemory(await input(),takeId(key),part==='revoke'));
      }
    }
    if (get && first==='library' && !part) return json(response,app.library(key));
    if (get && first==='recoveries' && !key) return json(response,app.recoveries());
    if (get && first==='receipts' && !key) return json(response,app.receipts({
      category:url.searchParams.get('category')??undefined,days:url.searchParams.get('days')??undefined
    }));
    if (post && first==='receipts' && key && part==='accounting' && !extra) {
      return json(response,app.recordAccounting(takeId(key),await input()));
    }
    if (post && first==='dependencies' && !key) return json(response,await app.recheckDependencies());
    if (get && first==='events' && !key) return events(response,host.store,streams);
    if (get && first==='projects' && !key) return json(response,await app.workbench.list());
    if (get && first==='projects' && key==='original' && !part) {
      if (app.config.allowOriginalWorkbench===false) throw new Problem(403,'独立工作台项目只在个人工作区可用。','workspace_scope');
      return json(response,await app.workbench.original.list());
    }
    if (first==='rooms') {
      if (!key && post) return json(response,{id:await app.open(await input())},201);
      if (key) takeId(key);
      if (key && !part && get) return json(response,app.room(key));
      if (key && part==='draft' && !extra && post) return json(response,app.saveDraft(key,await input()));
      if(key&&part==='specialist'&&!extra&&post) return json(response,app.startSpecialist(key,await input()),202);
      if(key&&part==='specialist-upload'&&!extra&&post) {
        requireRuntime();
        return json(response,await app.uploadSpecialist(key,url.searchParams.get('name')??'',request),201);
      }
      if(key&&part==='specialist-upload'&&extra&&leaf==='remove'&&post) {
        await input();
        return json(response,await app.removeSpecialistUpload(key,takeId(extra)));
      }
      if(key&&part==='specialist-download'&&extra&&leaf&&get) {
        const file=app.specialistFile(key,takeId(extra),leaf);
        const origin=await app.workbench.ensure();
        const asset=await fetch(origin+file.route,{redirect:'error',headers:{'X-Hyper-Bot-Bridge':app.workbench.bridgeKey}});
        if(!asset.ok||!asset.body)throw new Problem(404,'成片文件当前不可用。','not_found');
        response.writeHead(200,{'Content-Type':file.name.endsWith('.mp4')?'video/mp4':'application/octet-stream',
          'Cache-Control':'no-store','Content-Disposition':'attachment; filename="'+file.name+'"'});
        return pipeline(Readable.fromWeb(asset.body),response);
      }
      if (key && part==='memory' && !extra && post) return json(response,app.setMemoryPreference(key,await input()));
      if (key && part==='original' && !extra && get) return json(response,await app.originalContents(key));
      if (key && part==='original' && extra==='materials' && !leaf && post) {
        return json(response,{id:await app.importOriginalMaterial(key,await input())},201);
      }
      if (key && part==='materials' && !extra && post) return json(response,{id:app.upload(key,await input())},201);
      if (key && part==='materials' && extra) {
        const file=takeId(extra);
        if (!leaf && get) return json(response,app.source(key,file));
        if (leaf==='deadline' && post) return json(response,app.setDeadline(key,file,await input()));
        if (leaf==='revoke' && post) return json(response,app.revokeMaterial(key,file,await input()),202);
      }
      if (key && part==='runs' && !extra && post) return json(response,await app.start(key,await input()),202);
      if (key && part==='teaching-assistant' && !extra && post) return json(response,app.startTeachingAssistant(key,await input()),202);
    }
    if (first==='runs' && key && !extra) {
      takeId(key);
      if (get && part==='events') {
        const after=Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after<0) throw new Problem(422,'事件序号无效。');
        return json(response,host.store.events.all(key,after).map(row=>({...row,data:JSON.parse(row.data)})));
      }
      if (post && part==='decide') return json(response,{decision:app.decide(key,await input())},202);
      if (post && part==='revise') return json(response,{decision:app.returnProposal(key,await input())},202);
      if (post && part==='stop') {app.stop(key);return json(response,{},202);}
      if (post && part==='recover') return json(response,await app.recover(key));
    }
    if (get && first==='artifacts' && key && part==='export' && !extra) {
      const artifact=takeId(key), format=url.searchParams.get('format');
      if (format==='bundle') {
        if (request.headers['x-hyper-bot']!=='1') {
          throw new Problem(403,'导出请求无效。','invalid_export');
        }
        return zipDownload(response,artifactArchive(host.store,artifact));
      }
      return json(response,artifactBundle(host.store,artifact,format==='filename'));
    }
    if (get && first==='bots' && key && extra==='history-export' && !leaf) {
      const revision=Number(part);
      if (!Number.isSafeInteger(revision)||revision<1) throw new Problem(422,'Bot 版本无效。');
      const summaryOnly=url.searchParams.get('format')==='summary';
      if (!summaryOnly && request.headers['x-hyper-bot']!=='1') {
        throw new Problem(403,'导出请求无效。','invalid_export');
      }
      const archive=retiredBotArchive(host.store,botKey.parse(key),revision,summaryOnly);
      if (summaryOnly) return json(response,archive);
      return zipDownload(response,archive,{'X-Hyper-Bot-Exported':archive.count});
    }
    if (get && first==='bots' && key && extra==='sample-preview' && !leaf) {
      const revision=Number(part);
      if (!Number.isSafeInteger(revision)||revision<1) throw new Problem(422,'Bot 版本无效。');
      if (request.headers['x-hyper-bot']!=='1') {
        throw new Problem(403,'样例预览请求无效。','invalid_sample_preview');
      }
      return json(response,registry.samplePreview(botKey.parse(key),revision));
    }
    if (post && first==='skills' && !key) return json(response,{id:registry.ingest(await input())},201);
    if (post && first==='skills' && key && part==='revoke' && !extra) return json(response,app.revokeSkill(key,await input()));
    if (post && first==='harnesses' && key && !part) {await registry.registerDriver(key);return json(response,{});}
    if (post && first==='bots') {
      if(!key) return json(response,registry.draft(await input()),201);
      const revision=Number(part);
      if (!Number.isSafeInteger(revision)||revision<1) throw new Problem(422,'Bot 版本无效。');
      if (extra==='verify' && !leaf) {
        if (host.store.read().runs.some(isLive)) throw new Problem(409,'请等当前会话任务结束再验证。','busy');
        return json(response,await registry.verify(key,revision));
      }
      if (extra==='publish' && !leaf) return json(response,await registry.publish(key,revision));
      if (extra==='restore' && !leaf) return json(response,await registry.restore(key,revision));
      if (extra==='disable' && !leaf) {registry.disable(key,revision);return json(response,{});}
    }
    throw new Problem(404,'接口不存在。','not_found');
  })();
}

async function staticPage(request,response,url,dev,frontendAssets) {
  if (!['HEAD','GET'].includes(request.method)) throw new Problem(405,'不支持此请求方式。');
  if (dev && url.pathname!=='/') {
    await new Promise((resolve,reject)=>{
      response.once('finish',resolve); response.once('close',resolve);
      dev.middlewares(request,response,error=>error?reject(error):reject(new Problem(404,'页面不存在。')));
    });
    return;
  }
  if (url.pathname === '/' && dev) {
    const html=await dev.transformIndexHtml('/',await readFile(path.join(root,'index.html'),'utf8'));
    response.writeHead(200,{'Content-Type':mediaTypes['.html'],'Cache-Control':'no-store'});
    response.end(request.method==='HEAD'?undefined:html);
    return;
  }
  const target=url.pathname==='/' ? 'index.html' : url.pathname.slice(1);
  const suffix=path.extname(target);
  if (!/^[a-zA-Z0-9_./-]+$/.test(target) || target.split('/').some(part=>part==='..' || part==='.') ||
      !Object.hasOwn(mediaTypes,suffix)) throw new Problem(404,'页面不存在。');
  const bytes=await readFile(path.join(frontendAssets,target)).catch(error=>{
    if(error.code==='ENOENT') throw new Problem(404,'请先构建 Hyper Bot 前端。');
    throw error;
  });
  response.writeHead(200,{'Content-Type':mediaTypes[suffix],'Cache-Control':'no-cache',
    'Content-Length':bytes.length,
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"});
  response.end(request.method==='HEAD'?undefined:bytes);
}

export async function launch({port=0,dev=false,options={},workbenchFactory,windowKey,frontendAssets=path.join(root,'dist')}={}) {
  if (windowKey!==undefined && !validWindowKey(windowKey)) throw new Error('桌面窗口凭据无效。');
  const config=await configFor(options);
  await mkdir(config.data,{recursive:true,mode:0o700});
  const release=await workspaceLock(config.data);
  const streams=new Set();
  const teaching=teachingServices();
  let store, app, groups, vite, expiry, server, setting=false, mutations=0;
  const configuring=()=>setting||app.runtimeChanging;
  const chat=groupChat(()=> 'http://127.0.0.1:'+server.address().port,windowKey);
  try {
    store=new Store(path.join(config.data,'hyper-bot.sqlite'));
    await store.init();
    app=new HyperBot(store,config,workbenchFactory?.(config) ?? new Workbench(config));
    if (dev) {
      const {createServer}=await import('vite');
      vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
    }
    const host={store,app,group:personalWorkspace};
    groups=new WorkspaceGroups(host,config,workbenchFactory);
    let ready=false;
    server=http.createServer(async(request,response)=>{
      let mutation=false;
      try {
        const origin='http://127.0.0.1:'+server.address().port;
        if (request.headers.host!==new URL(origin).host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
          throw new Problem(403,'仅对本机 Hyper Bot 窗口开放。');
        }
        const url=new URL(request.url,origin);
        response.setHeader('X-Content-Type-Options','nosniff');
        response.setHeader('Referrer-Policy','no-referrer');
        response.setHeader('X-Frame-Options','DENY');
        if (url.pathname.startsWith('/api/')) {
          if (request.headers.origin && request.headers.origin!==origin) throw new Problem(403,'操作来源无效。');
          if (windowKey!==undefined && !matchesWindowKey(request.headers[windowHeader],windowKey)) {
            throw new Problem(403,'此请求需要来自当前 Hyper Bot 桌面窗口。','window_access');
          }
          if (request.method==='POST') {
            const upload=/^\/api\/(?:v1\/workspaces\/[^/]+\/)?rooms\/[^/]+\/specialist-upload$/.test(url.pathname);
            const teachingUpload=/^\/api\/(?:v1\/workspaces\/[^/]+\/)?rooms\/[^/]+\/teaching\/upload$/.test(url.pathname);
            const groupUpload=/^\/api\/v1\/workspaces\/[^/]+\/group-files$/.test(url.pathname);
            const mediaType=teachingUpload?/^multipart\/form-data;\s*boundary=/i:(upload||groupUpload)?/^application\/octet-stream\b/:/^application\/json\b/;
            if(!mediaType.test(request.headers['content-type']??'')||request.headers['x-hyper-bot']!=='1') {
              throw new Problem(403,'操作请求无效。');
            }
          }
          if (!ready) throw new Problem(503,'本机服务正在恢复。','host_starting');
          if (configuring()) throw new Problem(503,'本机服务正在应用组件设置。','runtime_restarting');
          if (request.method==='POST') {mutation=true;mutations++;}
          if (url.pathname==='/api/v1/workspaces') {
            if (request.method==='GET') return json(response,groups.list());
            if (request.method==='POST') {
              const value=await jsonBody(request);
              if (configuring()) throw new Problem(503,'本机服务正在应用组件设置。','runtime_restarting');
              return json(response,await groups.create(value),201);
            }
          }
          const scoped=/^\/api\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname);
          const destination=scoped?await groups.get(scoped[1]):host;
          if (scoped) url.pathname='/api'+scoped[2];
          if(url.pathname==='/api/choose-group-folder'&&request.method==='POST'){
            await jsonBody(request);
            return json(response,{folder:await chooseGroupFolder()});
          }
          if(url.pathname.startsWith('/api/group-')){
            if(!scoped||destination.group.id==='personal')throw new Problem(404,'请打开群组。');
            if(url.pathname==='/api/group-chat'){
              if(request.method==='GET')return json(response,await chat.view(destination));
              if(request.method==='POST')return json(response,await chat.send(destination,await jsonBody(request)),201);
            }
            if(url.pathname==='/api/group-folder'&&request.method==='POST'){
              const value=await groups.attach(destination,(await jsonBody(request)).folder);return json(response,{folder:value.folder});
            }
            if(url.pathname==='/api/group-files'&&request.method==='POST')return json(response,await saveGroupFile(destination,url.searchParams.get('name'),request),201);
            const file=/^\/api\/group-files\/([^/]+)(\/preview)?$/.exec(url.pathname);
            if(file&&request.method==='GET')return await downloadGroupFile(destination,file[1],response,Boolean(file[2]));
            throw new Problem(404,'群组接口不存在。');
          }
          const teachingRoute=/^\/api\/rooms\/([^/]+)\/teaching\/([a-z-]+)$/.exec(url.pathname);
          const studentRoute=/^\/api\/teaching\/students\/(login|trial|logout|context|records|detail|record-write)$/.exec(url.pathname);
          if(studentRoute) {
            if(destination.group.id!=='personal')throw new Problem(404,'请在个人工作区打开学员档案。','teaching_scope');
            if(!['GET','POST'].includes(request.method))throw new Problem(405,'不支持此操作。');
            return await (await teaching.forHost(destination)).handleStudents(request,response,url,studentRoute[1],json);
          } else if(teachingRoute) {
            if(!['GET','POST'].includes(request.method))throw new Problem(405,'不支持此操作。');
            await (await teaching.forHost(destination)).handle(request,response,url,destination,teachingRoute[1],teachingRoute[2],json);
          } else await apiMethod(request,response,url,destination,streams,configuring);
        } else {
          const preview=/^\/teaching-preview\/([0-9a-f-]{36})$/.exec(url.pathname);
          if(preview)return await teaching.render(request,response,preview[1]);
          const workspacePage=/^\/w\/([0-9a-f-]{36})\/$/.exec(url.pathname);
          if (workspacePage) {
            if (!groups.list().some(item=>item.id===workspacePage[1])) throw new Problem(404,'工作区不存在。','not_found');
            url.pathname='/';
          }
          await staticPage(request,response,url,vite,frontendAssets);
        }
      } catch(error) {sendError(response,error);}
      finally {if(mutation)mutations--;}
    });
    server.listen(port,'127.0.0.1');
    await once(server,'listening');
    // Preserve pending recovery if this process cannot own the local listener.
    await app.boot();
    ready=true;
    expiry=setInterval(()=>{app.expire();void groups.expire();},1000);
    expiry.unref();
  } catch(error) {
    if (server?.listening) await new Promise(resolve=>server.close(resolve));
    await teaching.close();
    await groups?.close();
    await app?.shutdown();
    await vite?.close();
    store?.close();
    await release();
    throw error;
  }
  const origin='http://127.0.0.1:'+server.address().port;
  let closing;
  return {origin,app,store,config, async configure(message,operation) {
    if (setting || mutations || app.runtimeChanging) throw new Problem(409,message,'busy');
    setting=true;
    try {
      await groups.requireIdle(message);
      const result=await operation();
      for (const {store} of await Promise.all(groups.hosts.values())) store.change(()=>{});
      return result;
    } finally {setting=false;}
  }, close() {
    closing ??= (async()=>{
      clearInterval(expiry);
      for(const stream of streams) stream.end();
      const drained=new Promise(resolve=>server.close(resolve));
      server.closeIdleConnections();
      app.registry.controller?.abort(new Error('Host closing'));
      try {
        await chat.close();
        await drained;
        await teaching.close();
        try {await groups.close();} finally {await app.shutdown();}
      } finally {
        await vite?.close();
        store.close();
        await release();
      }
    })();
    return closing;
  }};
}

