import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { id, Problem } from './contracts.mjs';

export const expiredMaterial = (file, now = Date.now()) =>
  !!file.authorizedAt && !!file.expiresAt && Date.parse(file.expiresAt) <= now;

export const activeMaterial = file => !!file?.authorizedAt && !expiredMaterial(file);

export const visibleArtifact = (record,material) => !!record.result && !record.endedAt &&
  record.materialIds.every(id=>activeMaterial(material(id)));

export const materialVisibleIn = (file,room) => !!file &&
  (file.conversation===room || (file.sharedWith?.includes(room) ?? false));

export function materialMetadata(file) {
  const { content, pendingDigest, sharedWith, ...meta } = file;
  return {...meta,...(sharedWith?.length?{shared:true}:{})};
}

export function materialIn(state, room, id) {
  const file = state.materials.find(row=>row.id===id && materialVisibleIn(row,room));
  if (!file) throw new Problem(403,'本轮只能使用在此会话授权过的材料。','material_scope');
  return file;
}

export function authorizedMaterials(state, room, ids) {
  if (new Set(ids).size !== ids.length) throw new Problem(422,'请选择不同的材料。');
  const files = ids.map(id=>materialIn(state,room,id));
  if (files.some(file=>!activeMaterial(file))) {
    throw new Problem(410,'材料授权已结束。请另选可用材料。','material_ended');
  }
  if (files.reduce((n,file)=>n+Buffer.byteLength(file.content),0)>128000) {
    throw new Problem(422,'本轮授权文本合计最多 128 KB。');
  }
  return files;
}

export const runsUsing = (state, file) => state.runs.filter(run=>
  materialVisibleIn(file,run.conversation) && run.materialIds.includes(file.id));

export function hidesArtifact(record, endedAt) {
  const {result,timing,...receipt} = record;
  return {...receipt,endedAt};
}

export function retireMaterial(store,state,emit,file,reason,endedAt) {
  const runs = runsUsing(state,file);
  const runIds = new Set(runs.map(run=>run.id));
  const discarded = state.artifacts.filter(record=>runIds.has(record.run));
  const retiredIds = new Set(discarded.map(record=>record.id));
  for (const room of state.conversations) {
    const draft=room.draft;
    const returned=room.draftProposal?.stamp===room.draftStamp && runIds.has(room.draftProposal?.id);
    if ((materialVisibleIn(file,room.id) && draft?.attachments.includes(file.id)) || retiredIds.has(draft?.base) ||
        returned) {
      room.draft={text:'',attachments:draft.attachments.filter(id=>id!==file.id),base:null};
      delete room.draftRetry;
      delete room.draftProposal;
    }
  }
  state.retiredArtifacts ??= [];
  state.retiredArtifacts.push(...discarded.map(record=>hidesArtifact(record,endedAt)));
  state.artifacts=state.artifacts.filter(record=>!retiredIds.has(record.id));
  const abort=[];
  for (const run of runs) {
    if (run.endedAt) continue;
    const note=reason==='expired'?'材料授权已到期。':'材料授权已撤回。';
    run.endedAt=endedAt;
    run.prompt='此消息已随材料授权清理。';
    delete run.plan;
    delete run.generation;
    delete run.approval;
    run.error=null;
    run.recovery=null;
    if (['queued','running','recovering'].includes(run.state)) {
      const stop={trigger:'material',fromState:run.state,requestedAt:endedAt};
      emit(run,'stop_requested',stop);
      store.transition(state,emit,run,'stopping',{error:note,stop});
      abort.push(run.id);
    } else if (run.state==='waiting_approval') {
      store.transition(state,emit,run,'cancelled',{error:note});
    } else if (run.state==='saving' && !run.commitStarted) {
      store.transition(state,emit,run,'interrupted',{error:note});
    }
    emit(run,'material_ended',{materialId:file.id,reason,endedAt});
  }
  const record={id:file.id,conversation:file.conversation,name:'材料授权已结束',endedAt,reason,cleanup:'pending',
    pendingDigest:file.digest,...(file.sharedWith?{sharedWith:file.sharedWith}:{})};
  state.materials[state.materials.indexOf(file)]=record;
  return {record,abort};
}

export const hasUnclearedMaterials = state => state.materials?.some(file=>file.cleanup==='pending' || expiredMaterial(file)) ?? false;

export function assertArchiveSafe(state) {
  if (hasUnclearedMaterials(state)) {
    throw new Problem(409,'工作区有待清理的材料。请在当前工作区完成清理后重新备份。','material_cleanup');
  }
}

export async function cleanRuntime(data, run) {
  const parent=path.join(await realpath(data),'runtime');
  const folder=path.join(parent,id.parse(run));
  const info=await lstat(folder).catch(error=>{
    if (error.code!=='ENOENT') throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent)!==parent || await realpath(folder)!==folder) {
    throw new Error('Hyper Bot runtime copy is outside its workspace.');
  }
  await rm(folder,{recursive:true,maxRetries:3,retryDelay:80});
}

