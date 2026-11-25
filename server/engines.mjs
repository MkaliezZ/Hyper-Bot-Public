import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Problem } from './contracts.mjs';
import { DSH_VERSION, HERMES_REVISION, dependencies, processEnvironment, requireRuntimeSource, root } from './config.mjs';
import { provider } from './provider.mjs';
import { runWebDsh } from './dsh-web-host.mjs';
import { waitForExit } from './process-exit.mjs';
import { workbenchScriptWorkflow } from './workbench-workflow.mjs';

export function patchFor(url, model) {
  // The sdk-minimal profile and patch pattern are shared with self-media-bot.
  return [
    ...['persistent-pwsh', 'persistent-bash', 'tool-working-directory', 'session-log-deepseek',
      'plugin-package-inventory-deepseek'].map(id => ({id, disabled:true})),
    {id:'tool-fs',config:{read:false,readImage:false,write:false,edit:false}},
    {id:'llm-deepseek',config:{apiKeyEnv:'DEEPSEEK_API_KEY',baseURL:url,maxTokens:4096,
      thinking:'disabled',reasoningEffort:'off',streamIdleTimeoutMs:60000,
      models:[{id:model,contextWindow:128000,maxTokens:4096,inputModalities:['text']}]}},
    {id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,
      personaPrefix:'Hyper Bot 受限文字执行器。只生成所需 JSON。'}}
  ];
}

async function dsh(config, job, prompt, gateway, signal, onEngine, turn) {
  const {DeepSeekHarness}=await import('@deepseek-ai/dsh-sdk-client');
  const patchPath = path.join(job, 'sdk.patch.json');
  await writeFile(patchPath, JSON.stringify(patchFor(gateway, config.model)));
  const harness = new DeepSeekHarness({ profile:'sdk-minimal', dshHome:job, cwd:job, processCwd:job,
    patches:[patchPath], provider:'deepseek-official', model:config.model, maxTokens:4096,
    env:processEnvironment({ DEEPSEEK_API_KEY:'sk-' + '0'.repeat(32) }),
    initializeTimeoutMs:30000, shutdownTimeoutMs:1500, disposeEofGraceMs:800, disposeGraceMs:2500 });
  const sessionId = randomUUID();
  let closing,interrupt;
  const stopped=new Promise((_resolve,reject)=>{interrupt=reject;});
  const close=()=>closing??=harness.close().then(
    ()=>{turn.exited=true;},
    error=>{turn.exited=false;throw error;}
  );
  // This SDK revision closes its owned runtime and does not expose turn cancel.
  const stop=()=>{ void close().catch(()=>{}).then(()=>interrupt(signal.reason)); };
  signal.addEventListener('abort',stop,{once:true});
  try {
    signal.throwIfAborted();
    await Promise.race([harness.start(),stopped]);
    signal.throwIfAborted();
    onEngine(sessionId);
    const outcome=await Promise.race([harness.run(prompt,{sessionId}),stopped]);
    turn.terminal=outcome.finishReason==='completed'?'completed':'other';
    signal.throwIfAborted();
    if (!outcome.finalResponse || ['aborted','error','max-tokens'].includes(outcome.finishReason)) {
      throw new Problem(502, 'DSH 本轮没有返回完整成果。', 'runtime_error');
    }
    return outcome.finalResponse;
  } finally {
    signal.removeEventListener('abort', stop);
    await close();
  }
}

async function hermes(config, job, prompt, gateway, signal, onEngine, turn) {
  await requireRuntimeSource(config,'hermes',signal);
  await writeFile(path.join(job,'config.yaml'), JSON.stringify({model_catalog:{enabled:false}}));
  signal.throwIfAborted();
  const env = processEnvironment({ HERMES_HOME:job,HERMES_ACP_SKIP_CONFIGURED_MCP:'1',
    PYTHONUTF8:'1', PYTHONDONTWRITEBYTECODE:'1', HYPER_BOT_ACP_MODEL_URL:gateway + '/v1',
    HYPER_BOT_ACP_MODEL:config.model });
  const child = spawn(config.hermesPython, ['-B', '-X', 'utf8', path.join(root,'scripts/hermes_acp.py'),config.hermesRoot],
    {cwd:job,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const waiting = new Map();
  let sessionId, seq = 0, result = '', invalid = false;
  let hint = '';
  child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  const fail = error => {
    for (const {reject} of waiting.values()) reject(error);
    waiting.clear();
  };
  child.on('error', () => fail(new Problem(503,'Hermes ACP 无法启动。','runtime_error')));
  child.stdin.on('error', () => {});
  void closed.then(() => fail(new Problem(502,'Hermes ACP 会话已断开。' + hint,'runtime_error')));
  const send = body => child.stdin.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n');
  const request = (method,params) => new Promise((resolve,reject) => {
    if (child.exitCode !== null || !child.stdin.writable) {
      reject(new Problem(502,'Hermes ACP 已关闭。','runtime_error'));
      return;
    }
    const id=++seq;
    waiting.set(id,{resolve,reject});
    send({id,method,params});
  });
  const lines = createInterface({input:child.stdout});
  lines.on('line', line => {
    let packet;
    try {packet = JSON.parse(line);} catch {return;}
    if (packet.method && packet.id !== undefined) {
      invalid = true;
      send({id:packet.id,error:{code:-32601,message:'Hyper Bot ACP only accepts text session notifications'}});
    } else if (packet.method === 'session/update' && packet.params?.sessionId === sessionId) {
      const update = packet.params.update;
      const type = update?.sessionUpdate;
      if (type === 'agent_message_chunk' && update.content?.type === 'text') result += update.content.text;
      if (type === 'tool_call' || type === 'tool_call_update') invalid = true;
    } else if (waiting.has(packet.id)) {
      const {resolve,reject}=waiting.get(packet.id);
      waiting.delete(packet.id);
      if (packet.error) {
        hint = ' ACP ' + (Number(packet.error.code) || -1) + '。';
        reject(new Problem(502,'Hermes ACP 未完成本轮。' + hint,'runtime_error'));
      } else resolve(packet.result);
    }
  });
  let cancelTimer;
  const stop = () => {
    if (turn.submitted && child.stdin.writable) {
      send({method:'session/cancel',params:{sessionId}});
      cancelTimer=setTimeout(()=>fail(signal.reason),2300);
    } else fail(signal.reason);
  };
  signal.addEventListener('abort',stop,{once:true});
  try {
    signal.throwIfAborted();
    await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'Hyper Bot',version:'0.1.0'}});
    const session = await request('session/new',{cwd:job,mcpServers:[]});
    sessionId = session.sessionId;
    if (!sessionId) throw new Problem(502,'Hermes ACP 没有返回会话编号。','runtime_error');
    onEngine(sessionId);
    const outcome=await request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]});
    if (outcome?.stopReason==='cancelled') turn.terminal='cancelled';
    else turn.terminal=outcome?.stopReason==='end_turn'?'completed':'other';
    signal.throwIfAborted();
    if (invalid || turn.terminal!=='completed' || !result.trim()) {
      throw new Problem(502,'Hermes ACP 本轮没有返回完整的纯文本成果。','runtime_error');
    }
    return result;
  } finally {
    signal.removeEventListener('abort',stop);clearTimeout(cancelTimer);
    lines.close();
    if (child.exitCode===null && !child.signalCode) child.kill();
    turn.exited=await waitForExit(closed,2000);
    if (!turn.exited) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
}

export const DRIVERS = {
  dsh: { id:'dsh', name:'DeepSeek Harness · SDK', revision:DSH_VERSION, capabilities:['text','cancel','script'], run:dsh },
  'dsh-web': {id:'dsh-web',name:'DeepSeek Harness · Web Host',revision:DSH_VERSION,capabilities:['text','cancel','script'],
    workflows:[workbenchScriptWorkflow],
    run:(config,job,prompt,url,signal,onEngine,turn)=>runWebDsh(job,config.model,patchFor(url,config.model),prompt,signal,onEngine,turn)},
  hermes: { id:'hermes', name:'Hermes ACP', revision:HERMES_REVISION, capabilities:['text','cancel'], run:hermes }
};

export class RuntimeStop extends Error {
  constructor(turn) {
    super('Hyper Bot runtime stopped');
    this.turn=turn;
  }
}

export async function execute(config, driver, runId, prompt, signal, onEngine, onUsage, onProviderComplete, onProviderAttempt, onStartupRetry) {
  const blocked = dependencies(config)[driver];
  if (blocked) throw new Problem(503,blocked,'dependency_unavailable');
  const actual = AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]);
  const job = path.join(config.data,'runtime',runId);
  await mkdir(job,{recursive:true});
  const gateway=await provider(config,actual,onProviderComplete,onProviderAttempt);
  const turn={submitted:false,terminal:null,exited:null,onStartupRetry};
  const begin=(...identity)=>{
    onEngine(...identity);
    turn.submitted=true;
  };
  try {
    const response=await DRIVERS[driver].run(config,job,prompt,gateway.url,actual,begin,turn);
    actual.throwIfAborted();
    if (turn.exited===false) throw new Problem(502,'执行器退出未获确认。','runtime_teardown');
    const problem = gateway.error();
    if (problem) throw problem;
    if (!gateway.complete()) throw new Problem(502,'模型未返回可确认的结束帧。','provider_error');
    return response;
  } catch (error) {
    if (signal.aborted) throw new RuntimeStop(turn);
    if (actual.aborted) throw new Problem(504,'执行器超时。本轮已隔离，可在原会话重试。','runtime_timeout');
    throw gateway.error() ?? error;
  } finally {
    onUsage({...gateway.usage});
    await gateway.close();
  }
}

