import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Problem } from './contracts.mjs';

async function jsonBody(request, limit = 1024 * 1024) {
  const buffers = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Problem(413, '请求超过大小限制。');
    buffers.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(buffers))); }
  catch { throw new Problem(400, '请求需要有效的 UTF-8 JSON。'); }
}
export { jsonBody };

const tokenCount = value => Number.isSafeInteger(value)&&value>=0 ? value : null;
const receiptId = value => typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)?value:null;

export const unusedMeter = () => ({
  schema:1, requests:0, input:null, output:null, cached:null, cacheWrite:null,
  protocol:null, requestId:null, responseId:null, terminal:false
});

function foldUsage(value, usage, anthropic) {
  if (!value || typeof value!=='object') return;
  if (anthropic) {
    const uncached=tokenCount(value.input_tokens);
    const cached=tokenCount(value.cache_read_input_tokens);
    const cacheWrite=tokenCount(value.cache_creation_input_tokens);
    const parts=[uncached,cached,cacheWrite];
    Object.assign(usage,{input:parts.every(part=>part!==null)?tokenCount(uncached+cached+cacheWrite):null,
      output:tokenCount(value.output_tokens),cached,cacheWrite});
  } else {
    const cached=tokenCount(value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens);
    Object.assign(usage,{input:tokenCount(value.prompt_tokens),output:tokenCount(value.completion_tokens),cached});
  }
}

const toolBlock = type => typeof type==='string'&&type.split('_').includes('tool');
const usesTool = message => !!message?.function_call ||
  (message?.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0));

function checkModelResponse(value,anthropic) {
  if (!value || typeof value!=='object' || Array.isArray(value)) {
    throw new Problem(502,'模型返回了无法核对的响应。','provider_error');
  }
  const toolResponse=anthropic
    ? toolBlock(value.type)||toolBlock(value.content_block?.type)||toolBlock(value.delta?.type)||value.delta?.type==='input_json_delta'||
      [value.stop_reason,value.delta?.stop_reason,value.message?.stop_reason].includes('tool_use')||
      [value.content,value.message?.content].some(blocks=>Array.isArray(blocks)&&blocks.some(block=>toolBlock(block?.type)))
    : Array.isArray(value.choices)&&value.choices.some(choice=>usesTool(choice?.message)||usesTool(choice?.delta)||
      ['tool_calls','function_call'].includes(choice?.finish_reason));
  if (toolResponse) throw new Problem(502,'模型返回了本轮禁用的工具动作。','runtime_policy');
}

function inspectEvent(frame,usage,anthropic) {
  const lines=frame.split('\n');
  const isData=line=>line==='data'||line.startsWith('data:');
  const data=lines.filter(isData).map(line=>line.slice(5).replace(/^ /,'')).join('\n').trim();
  if (!data) return {wire:frame+'\n\n',terminal:false};
  let terminal=!anthropic&&data==='[DONE]';
  let payload=data;
  if (!terminal) {
    let event;
    try {event=JSON.parse(data);}
    catch {throw new Problem(502,'模型返回了无法核对的流式响应。','provider_error');}
    usage.responseId??=receiptId(anthropic?event?.message?.id:event?.id);
    checkModelResponse(event,anthropic);
    if (!anthropic || event.type==='message_delta') foldUsage(event.usage,usage,anthropic);
    terminal=anthropic&&event.type==='message_stop';
    payload=JSON.stringify(event);
  }
  // Forward one checked data field per event so the runtime sees the same payload we checked.
  const wire=[...lines.filter(line=>!isData(line)),'data: '+payload,'',''].join('\n');
  return {wire,terminal};
}

async function* observeStream(body, usage, anthropic, completed) {
  const reader=body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const maxFrame=1024*1024;
  let pending='', trailingCarriageReturn=false;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) throw new Problem(502,'模型连接在结束帧之前中断。','provider_error');
      const decoded=decoder.decode(value,{stream:true});
      if (!decoded) continue;
      const text=trailingCarriageReturn?decoded.replace(/^\n/,''):decoded;
      trailingCarriageReturn=decoded.endsWith('\r');
      pending+=text.replace(/\r\n|\r/g,'\n');
      for (let end=pending.indexOf('\n\n');end>=0;end=pending.indexOf('\n\n')) {
        if (end>maxFrame) throw new Problem(502,'模型返回的流式响应超过大小限制。','provider_error');
        const event=inspectEvent(pending.slice(0,end),usage,anthropic);
        pending=pending.slice(end+2);
        if (event.terminal) completed();
        yield event.wire;
        if (event.terminal) return;
      }
      if (pending.length>maxFrame) throw new Problem(502,'模型返回的流式响应超过大小限制。','provider_error');
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

const endpoints = { '/v1/messages': '/anthropic/v1/messages', '/chat/completions': '/chat/completions',
  '/v1/chat/completions': '/chat/completions' };

export async function provider(config, signal, onComplete, onAttempt) {
  const route = '/' + randomUUID();
  const lifetime = new AbortController();
  const usage = unusedMeter();
  let error = null, complete = false;
  const server = http.createServer(async (request, response) => {
    let responseComplete=false, admitted=false;
    const markComplete=()=>{
      usage.terminal=true;
      onComplete?.({...usage});
      complete=true;
      responseComplete=true;
    };
    try {
      const tail = request.url?.slice(route.length);
      if (request.method !== 'POST' || !request.url?.startsWith(route + '/') || !Object.hasOwn(endpoints, tail)) {
        response.writeHead(404).end();
        return;
      }
      const body = await jsonBody(request);
      // No runtime is given a provider credential or a model tool schema.
      if (body.model !== config.model || (body.tools && !Array.isArray(body.tools)) || body.tools?.length ||
          body.tool_choice || body.functions?.length || body.function_call) {
        throw new Problem(422, '运行时请求了未登记的模型或工具。', 'runtime_policy');
      }
      if (usage.requests >= 1) throw new Problem(429, '本轮模型请求已达到上限。', 'runtime_policy');
      signal.throwIfAborted();
      const anthropic = tail === '/v1/messages';
      const attempted={...usage,requests:1,protocol:anthropic?'messages':'chat-completions'};
      onAttempt?.(attempted);
      Object.assign(usage,attempted);
      admitted=true;
      error=null;
      const headers = anthropic
        ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer ' + config.key };
      headers['Content-Type'] = 'application/json';
      const safeBody = { ...body, max_tokens: Math.min(Number(body.max_tokens) || 4096, 4096) };
      delete safeBody.max_completion_tokens;
      if (!anthropic && safeBody.stream) safeBody.stream_options = { include_usage: true };
      const disconnected = new AbortController();
      response.once('close', () => {if (!response.writableFinished) disconnected.abort();});
      const upstream = await fetch(config.upstream + endpoints[tail], {
        method: 'POST', body: JSON.stringify(safeBody), headers, redirect: 'error',
        signal: AbortSignal.any([signal, lifetime.signal, disconnected.signal])
      });
      usage.requestId=receiptId(upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id'));
      if (!upstream.ok) {
        throw new Problem(502, '模型服务返回 HTTP ' + upstream.status + '。', 'provider_error');
      }
      const type = upstream.headers.get('content-type') ?? 'application/json';
      if (type.includes('text/event-stream')) {
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        await pipeline(observeStream(upstream.body,usage,anthropic,markComplete),response);
      } else {
        const json = await upstream.json();
        usage.responseId=receiptId(json?.id);
        checkModelResponse(json,anthropic);
        foldUsage(json?.usage,usage,anthropic);
        markComplete();
        response.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(json));
      }
    } catch (cause) {
      // The protocol terminal may be consumed by the engine before the
      // transport finishes closing. Neither close changes that receipt.
      if (responseComplete || signal.aborted || lifetime.signal.aborted) return;
      const failure=cause instanceof Problem ? cause : new Problem(502, '模型连接中断或不可用。', 'provider_error');
      // Report the admitted response even if the runtime retries after the stream closes.
      if (admitted || usage.requests===0) error=failure;
      if (response.headersSent) response.destroy();
      else response.writeHead(failure.status, {'Content-Type':'application/json'}).end(JSON.stringify({
        type:'error', error:{type:'invalid_request_error',message:failure.message}
      }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port + route, usage,
    error: () => error,
    complete: () => complete,
    async close() {
      lifetime.abort();
      const done = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await done;
    }
  };
}

