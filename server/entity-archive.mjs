import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, Problem } from './contracts.mjs';
import { authorizedMaterials } from './materials.mjs';
import { quoteLocation } from './export.mjs';

const namespace='hyper-bot.local';
const purpose='hyper-bot.task-context';
const localOwner='本人 · 此设备';
const version=z.string().regex(/^[1-9]\d*$/);
export const entityRef=z.strictObject({claim_id:id,version});
const confirmation=z.strictObject({artifact:id,form:z.enum(['confirmed','participated']),confirmed:z.literal(true)});
const revocation=z.strictObject({version,confirmed:z.literal(true)});
const policy=z.enum(['confirmed','participated']);

export const entityUnavailable=new Problem(409,'这条档案或它的依据已不可用，请移除引用后重新发送。','entity_unavailable');

const records=state=>state.entityRecords??[];
const match=(record,ref)=>record.claim.claim_id===ref?.claim_id&&record.claim.version===ref.version;
const claimReference=({namespace,claim_id,version})=>({namespace,claim_id,version});
export const sameEntityRef=(a,b)=>a?.claim_id===b?.claim_id&&a?.version===b?.version;

export function entityOwner(state,now) {
  if (!state.entityOwner) {
    const entity_id=randomUUID();
    state.entityOwner={namespace,entity_id,version:'1',entity_type:'person',registered_by:entity_id,recorded_at:now};
  }
  return state.entityOwner;
}

const archivalVersion=artifact=>String(artifact.version);

function source(state,artifact) {
  const run=artifact&&state.runs.find(row=>row.id===artifact.run);
  const room=artifact&&state.conversations.find(row=>row.id===artifact.conversation);
  if (!artifact?.result || artifact.endedAt || artifact.kind!=='script' || !artifact.receipt ||
      !run || run.endedAt || run.artifact!==artifact.id || run.approval?.status!=='accepted' ||
      !room || room.simulation || room.original) return null;
  try {
    return {artifact,run,room,materials:authorizedMaterials(state,room.id,artifact.materialIds)};
  } catch(error) {
    if (error instanceof Problem) return null;
    throw error;
  }
}

function label({artifact}) {
  return artifact.result.title+' · v'+artifact.version;
}

function statement(form,{artifact}) {
  return (form==='participated'?'参与确认了':'确认了')+'《'+artifact.result.title+'》口播分镜 v'+artifact.version+'。';
}

function proof({artifact,run,materials},approval) {
  const evidence=[
    {asset_ref:{asset_id:artifact.id,version:archivalVersion(artifact)},
      locator:{kind:'artifact_version',value:'v'+artifact.version},relation:'supports'},
    {asset_ref:{asset_id:run.id,version:String(approval.seq)},
      locator:{kind:'approval_event',value:String(approval.seq)},relation:'supports'}
  ];
  const provenance=[];
  for (const segment of artifact.result.segments??[]) {
    for (const citation of segment.evidence??[]) {
      const material=materials.find(file=>file.id===citation.material);
      const locator=quoteLocation(material?.content,citation.quote);
      if (!material || !locator || provenance.some(item=>item.id===material.id)) continue;
      provenance.push({id:material.id,digest:material.digest,line:locator.line});
      evidence.push({asset_ref:{asset_id:material.id,version:material.digest},
        locator:{kind:'utf8_byte_range',value:locator.startByte+':'+locator.endByte},relation:'context'});
    }
  }
  return {evidence,provenance};
}

function currentSource(state,record) {
  if (record.revokedAt) return null;
  const found=source(state,state.artifacts.find(row=>row.id===record.source.artifact));
  if (!found || archivalVersion(found.artifact)!==record.claim.value.artifact_version ||
      found.run.approval.digest!==record.source.approvalDigest ||
      record.source.provenance.some(item=>!found.materials.some(file=>file.id===item.id&&file.digest===item.digest))) return null;
  return found;
}

function view(state,record) {
  const found=currentSource(state,record);
  const reason=record.revokedAt?'已撤回档案的复用许可。':!found?'原成果或材料授权已不可用。':null;
  return {ref:claimReference(record.claim),recordedAt:record.claim.recorded_at,reason,revoked:!!record.revokedAt,
    ...(found?{title:label(found),statement:statement(record.claim.value.form,found),source:{
      artifact:found.artifact.id,room:found.room.id,run:found.run.id,confirmedAt:record.source.confirmedAt,
      materials:record.source.provenance.map(item=>({id:item.id,line:item.line,
        name:found.materials.find(file=>file.id===item.id).name}))
    }}:{title:'口播分镜 v'+record.claim.value.artifact_version})};
}

export function archiveView(state) {
  return {owner:localOwner,records:records(state).map(record=>view(state,record)).reverse()};
}

export function draftEntityView(state,ref) {
  const record=records(state).find(item=>match(item,ref));
  if (!record) return null;
  const {title,reason}=view(state,record);
  return {ref,title,reason};
}

export function archiveSources(state) {
  return state.artifacts.slice().reverse()
    .map(artifact=>source(state,artifact)).filter(Boolean)
    .map(found=>({id:found.artifact.id,title:label(found)}));
}

export function archiveCandidate(store,state,key) {
  const found=source(state,state.artifacts.find(row=>row.id===key));
  const approval=found&&store.acceptedApproval.get(found.run.id,found.run.approval.digest);
  if (!found || !approval) throw new Problem(404,'这里没有可核对的本机口播成果。','entity_source');
  const existing=records(state).find(record=>record.source.artifact===key&&!record.revokedAt);
  const {provenance}=proof(found,approval);
  return {owner:localOwner,title:label(found),artifact:key,room:found.room.id,run:found.run.id,confirmedAt:approval.created,
    options:policy.options.map(value=>({value,label:statement(value,found)})),
    sources:provenance.map(item=>({id:item.id,line:item.line,name:found.materials.find(file=>file.id===item.id).name})),
    ...(existing?{existing:view(state,existing).ref}:{}),
    attributed:!!found.run.entityActor};
}

export function saveEntityRecord(store,state,raw,now) {
  const {artifact,form}=confirmation.parse(raw);
  const found=source(state,state.artifacts.find(row=>row.id===artifact));
  const approval=found&&store.acceptedApproval.get(found.run.id,found.run.approval.digest);
  if (!found || !approval) throw new Problem(409,'原分镜或确认回执已不可用。','entity_source');
  const prior=records(state).find(record=>record.source.artifact===artifact&&!record.revokedAt);
  if (prior) return view(state,prior);
  const {entity_id,version:ownerVersion}=entityOwner(state,now);
  if (found.run.entityActor && found.run.entityActor!==entity_id) {
    throw new Problem(403,'本次审批与当前本机档案主体不一致。','entity_scope');
  }
  const {evidence,provenance}=proof(found,approval);
  const claim={namespace,claim_id:randomUUID(),version:'1',subject:{namespace,entity_id,version:ownerVersion},
    predicate:'media.project.storyboard_confirmation',value:{form,artifact_version:archivalVersion(found.artifact)},
    scope:{project_id:found.artifact.project,artifact_id:artifact},claim_kind:'fact',origin_kind:'self_declared',
    asserted_by:entity_id,recorded_at:now,evidence};
  const record={claim,source:{artifact,approvalDigest:found.run.approval.digest,confirmedAt:approval.created,provenance}};
  (state.entityRecords??=[]).push(record);
  return view(state,record);
}

export function revokeEntityRecord(state,key,raw,now) {
  const {version}=revocation.parse(raw);
  const record=records(state).find(row=>match(row,{claim_id:key,version}));
  if (!record) throw new Problem(404,'档案记录不存在。','not_found');
  record.revokedAt??=now;
  return view(state,record);
}

export function validateEntitySelection(state,room,ref,available=false) {
  if (!ref) return;
  const record=records(state).find(item=>match(item,ref));
  if (!record || room.original || room.simulation || record.claim.subject.entity_id!==state.entityOwner?.entity_id) {
    throw new Problem(403,'只能在个人工作区的本机任务使用自己的档案。','entity_scope');
  }
  if (available && !currentSource(state,record)) throw entityUnavailable;
  return record;
}

export function grantEntityRead(state,room,ref,now,destination) {
  if (!ref) return {};
  const record=validateEntitySelection(state,room,ref,true);
  const {entity_id}=state.entityOwner;
  return {entityRef:ref,entityGrant:{namespace,grant_id:randomUUID(),version:'1',issuer:entity_id,grantee:'hyper-bot',
    actions:['read','disclose'],resources:[{claim_ref:claimReference(record.claim),fields:['value']}],
    purpose,destination,not_before:now,expires_at:new Date(Date.parse(now)+30*60*1000).toISOString()}};
}

export function entityContext(state,run,destination,now=Date.now()) {
  if (!run.entityRef) return null;
  const grant=run.entityGrant;
  const room=state.conversations.find(item=>item.id===run.conversation);
  const record=records(state).find(item=>match(item,run.entityRef));
  const found=record&&currentSource(state,record);
  const resource=grant?.resources?.[0];
  if (!found || !grant || !room || room.original || room.simulation ||
      grant.issuer!==state.entityOwner?.entity_id || grant.issuer!==run.entityActor ||
      record.claim.subject.entity_id!==grant.issuer || grant.destination!==destination ||
      grant.purpose!==purpose || grant.grantee!=='hyper-bot' || !grant.actions?.includes('read') ||
      !grant.actions?.includes('disclose') || !sameEntityRef(resource?.claim_ref,run.entityRef) ||
      !resource?.fields?.includes('value') ||
      !(now>=Date.parse(grant.not_before) && now<Date.parse(grant.expires_at))) throw entityUnavailable;
  return {summary:statement(record.claim.value.form,found),version:record.claim.version};
}
