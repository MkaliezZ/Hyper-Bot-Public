import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { id, Problem, sha } from './contracts.mjs';
import { payloadHash } from './workbench-protocol.mjs';

export const materialSignature = files => payloadHash(files.map(file=>[file.id,sha(file.content)]));

export function preparationReceipt(prepared) {
  if (!prepared) return null;
  return {
    project:prepared.project, revision:prepared.context.project.revision,
    contextId:prepared.context.context_id, sources:prepared.sources,
    original:prepared.original??null, pending:prepared.pending?.map(file=>file.id)??[]
  };
}

export function restorePreparation(saved,room,materials) {
  if (!saved) return null;
  if (room.project!==saved.project || payloadHash(room.original??null)!==payloadHash(saved.original)) {
    throw new Problem(409,'项目绑定已变化，请在原会话核对后继续。','workbench_conflict');
  }
  const pending=saved.pending.map(id=>{
    const file=materials.find(material=>material.id===id);
    if (!file) throw new Problem(403,'恢复时缺少本轮授权文字。','material_scope');
    return {id,name:file.name,content:file.content,digest:file.digest,nature:room.simulation?'simulation':'provided'};
  });
  return {project:saved.project,context:{project:{revision:saved.revision},context_id:saved.contextId},
    sources:saved.sources,original:saved.original,conversation:room.id,pending};
}

export function hasGenerationReceipt(run) {
  const proof=run.generation;
  return !!(proof?.version===1 && (proof.result || (run.driver==='dsh-web' && proof.provider?.requests===1 &&
    run.engineSession && proof.dshRequest && proof.promptDigest)));
}

const maxLogBytes=4*1024*1024;

async function readNativeTranscript(data,run,signal) {
  const runtime=path.join(await realpath(data),'runtime');
  const sessions=path.join(runtime,id.parse(run.id),'sessions');
  const owner=id.parse(run.engineSession);
  if (await realpath(sessions)!==sessions) return null;
  // A Hyper Bot run owns one DSH workspace and one Session. The workspace
  // folder is derived by DSH from its working directory, including on Windows.
  const folders=(await readdir(sessions,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink());
  if (folders.length!==1) return null;
  const filename=path.join(sessions,folders[0].name,owner,'session.v4.jsonl');
  if (await realpath(filename)!==filename) return null;
  const file=await open(filename,'r');
  try {
    const stat=await file.stat();
    if (!stat.isFile() || stat.size>maxLogBytes) return null;
    const buffer=Buffer.alloc(stat.size);
    const {bytesRead}=await file.read(buffer);
    signal.throwIfAborted();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead));
    const [header,...events]=text.trimEnd().split('\n').map(line=>JSON.parse(line));
    if (header?.type!=='session' || header.version!==4 || header.id!==owner ||
        header.isSeeded!==false || header.delegationDepth!==0 ||
        typeof header.cwd!=='string' || path.basename(header.cwd)!==run.id) return null;
    return events;
  } finally {
    await file.close();
  }
}

function completedAnswer(events,proof) {
  if (!events?.length || events.some((event,index)=>event.seq!==index)) return null;
  const users=events.filter(event=>event.type==='user/message' && event.data?.source?.kind==='user');
  const starts=events.filter(event=>event.type==='turn/start');
  const ends=events.filter(event=>event.type==='turn/end');
  if (users.length!==1 || starts.length!==1 || ends.length!==1) return null;
  const [user]=users,[start]=starts,[end]=ends;
  const turn=end.data?.turn;
  const content=user.data?.content;
  if (turn!==start.data?.turn || end.data?.reason?.kind!=='completed' || user.seq<=start.seq || user.seq>=end.seq ||
      user.data.source.rpcId!==proof.dshRequest || !Array.isArray(content) ||
      content.some(part=>part.type!=='text'||typeof part.text!=='string') ||
      sha(content.map(part=>part.text).join(''))!==proof.promptDigest ||
      events.some(event=>event.type.startsWith('tool/'))) return null;
  const replies=events.filter(event=>event.type==='assistant/message');
  if (!replies.length || replies.some(reply=>reply.data?.turn!==turn || reply.seq<=user.seq || reply.seq>=end.seq ||
      !Array.isArray(reply.data?.message?.content) ||
      reply.data.message.content.some(part=>part.type!=='text'||typeof part.text!=='string'))) return null;
  return replies.at(-1).data.message.content.map(part=>part.text).join('') || null;
}

export async function recoverWebText(data,run,signal) {
  // The former Worker can still be flushing after losing its parent. Poll the
  // same owned transcript briefly. No engine process or model is started here.
  for (const wait of [0,180,320,650]) {
    if (wait) await delay(wait,null,{signal});
    signal.throwIfAborted();
    const events=await readNativeTranscript(data,run,signal).catch(()=>null);
    signal.throwIfAborted();
    const output=completedAnswer(events,run.generation);
    if(output?.trim()) return output;
  }
  throw new Problem(409,'原执行器缺少可确认的完成记录。本轮已中断。','generation_unverified');
}

