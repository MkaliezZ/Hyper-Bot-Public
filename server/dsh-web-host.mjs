import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Problem } from './contracts.mjs';
import { processEnvironment } from './config.mjs';
import { waitForExit } from './process-exit.mjs';

const workerPath=fileURLToPath(new URL('./dsh-web-worker.mjs',import.meta.url));
const allowedMethods=new Set(['session/create','session/prompt','session/events','session/cancel']);
const seconds = value => AbortSignal.timeout(value*1000);
const taskUnavailable = () => new Problem(502,'DSH Web Host 未完成本轮。','runtime_error');

class WebHostTimeout extends Problem {
  constructor(phase) {
    super(503,phase==='startup'?'DSH Web Host 启动超时。':'DSH Web Host 本机连接超时。','runtime_unavailable');
    this.phase=phase;
  }
}

function hostRows(home,model) {
  const row=(id,name,config)=>({id,name:'@deepseek-ai/'+name,...(config?{config}:{})});
  return [
    ...['sdk-app-startup','sdk-jsonrpc-server','pty','terminal-pwsh','terminal-bash','tool-fs']
      .map(id=>({id,disabled:true})),
    {insert:[
      row('typert','dsh-typert-registry'),
      row('typert-loader','dsh-typert-loader'),
      row('typert-gateway','dsh-api-gateway',{websocketCompression:'none'}),
      row('remote-access','dsh-api-remote-access'),
      row('credentials','dsh-credentials-local'),
      row('agent-default-model','dsh-agent-default-model',{provider:'deepseek-official',model}),
      row('session-query','dsh-session-query-sqlite',{path:':memory:',openAt:'never'}),
      row('storage','dsh-storage'),
      row('storage-json','dsh-storage-json',{root:path.join(home,'storages')}),
      row('storage-domain','dsh-storage-domain',{backend:'json'}),
      row('workspace','dsh-workspace'),
      row('webserver','dsh-host-webserver',{host:'127.0.0.1',port:0}),
      row('connection','dsh-client-connection',{cookieMaxAgeDays:1}),
      row('commands','dsh-commands'),
      row('file-upload','dsh-client-file-upload'),
      row('session-controller','dsh-api-session-controller',{nativeOpen:false})
    ]}
  ];
}

async function waitForWorker(worker,signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const stopped=()=>settle(undefined,signal.reason);
    const failed=()=>settle(undefined,new Problem(503,'DSH Web Host 启动失败。','runtime_unavailable'));
    const ready=value=>settle(value);
    const settle=(value,error)=>{
      signal.removeEventListener('abort',stopped);
      worker.off('message',ready);
      worker.off('error',failed);
      worker.off('close',failed);
      if(error)reject(error);
      else resolve(value);
    };
    worker.on('message',ready).once('error',failed).once('close',failed);
    signal.addEventListener('abort',stopped,{once:true});
  });
}

async function startWebWorker(home,patch,signal) {
  signal.throwIfAborted();
  const worker=fork(workerPath,[patch],{
    cwd:home,execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],
    env:processEnvironment({DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'sk-'+'0'.repeat(32)})
  });
  worker.on('error',()=>{});
  const ended=new Promise(resolve=>worker.once('close',resolve));
  let shuttingDown;
  const close=()=>shuttingDown ??= (async()=>{
    if (worker.exitCode!==null || worker.signalCode) return true;
    if (worker.connected) worker.send('close',()=>{});
    else worker.kill();
    if (await waitForExit(ended,3600)) return true;
    worker.kill();
    if (await waitForExit(ended,2000)) return true;
    if (worker.connected) worker.disconnect();
    worker.unref();
    return false;
  })();
  let phase='startup';
  try {
    const {origin,token}=await waitForWorker(worker,AbortSignal.any([signal,seconds(24)]));
    const base=new URL(origin);
    if (base.protocol!=='http:' || base.hostname!=='127.0.0.1' || !base.port || !token) throw taskUnavailable();
    const exchange=new URL('/connect',base);
    exchange.searchParams.set('token',token);
    phase='connect';
    const response=await fetch(exchange,{redirect:'manual',signal:AbortSignal.any([signal,seconds(4)])});
    const cookie=response.headers.getSetCookie()[0]?.split(';',1)[0];
    if(response.status!==302 || !cookie) throw taskUnavailable();
    return {origin,cookie,close};
  } catch(error) {
    const closed=await close();
    signal.throwIfAborted();
    if (!closed) throw new Problem(502,'DSH Web Host 退出未获确认。','runtime_teardown');
    if (error?.name==='TimeoutError') throw new WebHostTimeout(phase);
    if (error instanceof Problem) throw error;
    throw new Problem(503,'DSH Web Host 未通过本机连接检查。','runtime_unavailable');
  }
}

export async function openWebDsh(home,model,patches,signal,onStartupRetry) {
  signal.throwIfAborted();
  const patch=path.join(home,'web-host.patch.json');
  await writeFile(patch,JSON.stringify([...patches,...hostRows(home,model)]));
  try {
    return await startWebWorker(home,patch,signal);
  } catch(error) {
    // Startup and the local identity exchange precede session creation.
    // The failed worker has exited, so a new one cannot duplicate a prompt.
    if (!(error instanceof WebHostTimeout) || signal.aborted) throw error;
    onStartupRetry?.({phase:error.phase,reason:'timeout',attempt:2});
    return startWebWorker(home,patch,signal);
  }
}

export async function webSessionCall(host,method,request,signal) {
  if(!allowedMethods.has(method)) throw new Problem(422,'DSH Web Host 方法未登记。','runtime_policy');
  const rpcId=randomUUID();
  const response=await fetch(host.origin+'/api/'+method,{
    method:'POST',redirect:'error',signal:AbortSignal.any([signal,seconds(6)]),
    headers:{'content-type':'application/json',cookie:host.cookie},
    body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:{request}}})
  });
  if (!response.ok) throw taskUnavailable();
  const envelope=await response.json();
  if (envelope.type!=='server-response' || envelope.rpcId!==rpcId || envelope.result?.ok!==true) throw taskUnavailable();
  return envelope.result.value;
}

export async function sessionEvents(host,sessionId,signal) {
  const page=await webSessionCall(host,'session/events',{address:{kind:'session',sessionId},maxMessages:40},signal);
  if (!Array.isArray(page?.records)) throw taskUnavailable();
  return page.records.filter(row=>row.type==='event').map(row=>row.event);
}

function terminalOf(end) {
  const reason=end.data?.reason;
  if (reason?.kind==='aborted' && reason.reason?.kind==='user') return 'cancelled';
  return reason?.kind==='completed' ? 'completed' : 'other';
}

async function confirmWebStop(host,sessionId,requestId) {
  const limit=seconds(3);
  const cancel=webSessionCall(host,'session/cancel',{sessionId},AbortSignal.any([limit,seconds(1.2)])).catch(()=>{});
  try {
    for (;;) {
      const events=await sessionEvents(host,sessionId,limit).catch(()=>[]);
      const user=events.find(event=>event.type==='user/message' && event.data?.source?.kind==='user' &&
        event.data.source.rpcId===requestId);
      const start=events.find(event=>event.type==='turn/start' && Number.isSafeInteger(event.data?.turn));
      const end=start && user && events.find(event=>event.type==='turn/end' &&
        event.data?.turn===start.data.turn && Number.isSafeInteger(event.seq) && event.seq>user.seq);
      if (end) return terminalOf(end);
      await delay(120,null,{signal:limit});
    }
  } catch(error) {
    if (!limit.aborted) throw error;
    return null;
  } finally {
    await cancel;
  }
}

export async function runWebDsh(home,model,patches,prompt,signal,onEngine,turn) {
  const host=await openWebDsh(home,model,patches,signal,turn.onStartupRetry);
  const sessionId=randomUUID(), requestId=randomUUID();
  try {
    const session=await webSessionCall(host,'session/create',{sessionId,cwd:home},signal);
    if (session?.sessionId!==sessionId) throw taskUnavailable();
    onEngine(sessionId,requestId);
    // Remote rc.1 can enqueue the same request twice before its durable user
    // event appears. Hyper Bot already deduplicates request acceptance. This
    // transport sends one prompt and never retries an ambiguous write.
    const ack=await webSessionCall(host,'session/prompt',{
      sessionId,requestId,mode:'queue',content:[{type:'text',text:prompt}]
    },signal);
    if (ack?.accepted!==true) throw taskUnavailable();
    for (;;) {
      const events=await sessionEvents(host,sessionId,signal);
      const end=events.find(event=>event.type==='turn/end');
      if (!end) { await delay(150,null,{signal}); continue; }
      turn.terminal=terminalOf(end);
      if (turn.terminal!=='completed') throw taskUnavailable();
      const messages=events.filter(event=>event.type==='assistant/message' && event.data?.turn===end.data.turn);
      const content=messages.at(-1)?.data?.message?.content;
      const answer=content?.filter(part=>part.type==='text').map(part=>part.text).join('');
      if (!answer?.trim()) throw taskUnavailable();
      return answer;
    }
  } catch(error) {
    if (signal.aborted) {
      if (turn.submitted && !turn.terminal) turn.terminal=await confirmWebStop(host,sessionId,requestId);
      throw signal.reason;
    }
    throw taskUnavailable();
  } finally {
    turn.exited=await host.close();
  }
}

