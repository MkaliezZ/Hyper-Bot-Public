import { randomUUID } from 'node:crypto';
import packageInfo from '../package.json' with { type:'json' };
import { z } from 'zod';
import { Problem, botKey, heading, id, message, textFile, definitionPrompt, resultOf, sha } from './contracts.mjs';
import { at, allArtifacts, artifactOf, botOf, conversationOf, draftToken, isLive, makeConversation, publicRun, revisableProposalIn,
  roomView, runOf, setRoomDraft } from './store.mjs';
import { approvedMethodsForRun, botBlock, Registry } from './registry.mjs';
import { dependencyStatus, inspectDependencies, inspectRuntimeInstallation } from './config.mjs';
import { unusedMeter } from './provider.mjs';
import { builtInCopy, specialistBot, specialistDirectory } from './specialist-catalog.mjs';
import { discardWorkbenchUpload, runMediaSpecialist, saveWorkbenchUpload, specialistInput, workbenchUploadPath } from './media-specialists.mjs';
import { generateTeachingReply } from './teaching-assistant.mjs';
import { receiptReport, storeAccounting, upstreamMode } from './run-receipts.mjs';
import { materializeExample } from './bot-sample.mjs';
import { changeMemory, listMemories, memoryChanged, memoryContext, memoryRefsFor } from './workspace-memory.mjs';
import { archiveCandidate, archiveSources, archiveView, draftEntityView, entityContext, entityOwner, entityRef, entityUnavailable,
  grantEntityRead, revokeEntityRecord, sameEntityRef, saveEntityRecord, validateEntitySelection } from './entity-archive.mjs';
import { DRIVERS, execute, RuntimeStop } from './engines.mjs';
import { libraryMaterials, libraryView, versionScope } from './history.mjs';
import { retiredHistorySummary } from './export.mjs';
import { hasGenerationReceipt, materialSignature, preparationReceipt, recoverWebText, restorePreparation } from './run-recovery.mjs';
import { payloadHash, planDigest } from './workbench.mjs';
import { projectId, scriptId, sourceId } from './workbench-protocol.mjs';
import { activeMaterial, authorizedMaterials, cleanRuntime, expiredMaterial, hidesArtifact, materialIn,
  materialMetadata, materialVisibleIn, retireMaterial, runsUsing, visibleArtifact } from './materials.mjs';

const handoffInput=z.strictObject({ from:id, materials:z.array(id).min(1).max(6),
  authorized:z.literal(true), requestId:id });
const roomInput = z.strictObject({ botId:botKey, revision:z.number().int().positive(), title:heading,
  project:z.string().regex(projectId).optional(), projectScope:z.literal('original').optional(),
  projectStorage:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  simulation:z.boolean().default(false),example:z.boolean().default(false),handoff:handoffInput.optional() });
const installInput = z.strictObject({botId:botKey});
const teachingAssistantInput=z.strictObject({requestId:id,text:message,evidence:z.string().trim().max(16000).default('')});
function installedBots(state) {
  return [...new Set([...(state.installedBots??state.bots.filter(bot=>bot.qualification==='pinned-dev').map(bot=>bot.id)),
    ...state.conversations.map(room=>room.botId)])];
}
const fileInput = textFile.extend({authorized:z.literal(true)});
const draftInput = z.strictObject({text:z.string().max(8000),attachments:z.array(id).max(6),base:id.nullable().default(null),
  originalBase:z.string().regex(scriptId).optional(),proposalBase:id.optional(),retryOf:id.optional(),entityRef:entityRef.optional()});
const projectMaterialInput=z.strictObject({source:z.string().regex(sourceId),digest:z.string().regex(/^[a-f0-9]{64}$/),authorized:z.literal(true)});
const fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const draftGuard={draftToken:fingerprint.optional()};
const draftSaveInput=draftInput.extend(draftGuard);
const runInput = draftInput.extend({...draftGuard,text:message,clientRequestId:id,authorized:z.literal(true),useWorkspaceMemory:z.boolean().optional()});
const memoryPreference=z.strictObject({enabled:z.boolean()});
const approvalIdentity=z.strictObject({id,digest:fingerprint});
const approvalInput=approvalIdentity.extend({allow:z.boolean()});
const revisionInput=approvalIdentity.extend({draftToken:fingerprint});
const deadlineInput=z.strictObject({expiresAt:z.iso.datetime().nullable()});
const revokeInput=z.strictObject({confirmed:z.literal(true)});
const skillRevokedMessage='本轮使用的 Skill 已撤销。';

const initialDraft = () => ({text:'',attachments:[],base:null});
function checkDraftToken(room,expected) {
  if(expected&&draftToken(room)!==expected) {
    throw new Problem(409,'此会话的已保存草稿已更新。','draft_conflict');
  }
}
const needsWriteCheck = run => run.state==='interrupted' && run.recovery==='required' && !!run.plan && !run.endedAt;
function retainUnwrittenDraft(run) {
  if (run.endedAt || !run.plan?.result || !run.approval) return false;
  run.approval.status='revoked';
  run.unwrittenDraft=true;
  return true;
}
const stopNotices={
  before_prompt:'已停止任务。模型执行尚未开始。',
  confirmed:'执行器已确认停止。本轮稿件未提交。',
  readback_stopped:'已停止核对。可在原会话再次发起。',
  approval_revoked:'已停止，待确认授权已撤销。',
  generation_discarded:'已停止保存准备。本轮仅完成生成。',
  unconfirmed:'停止未获执行器确认。本轮已隔离，可带回草稿。'
};

function recordStopRequest(run,emit,trigger,role) {
  run.stop={trigger,fromState:run.state,requestedAt:at()};
  emit(run,'stop_requested',{...run.stop,role});
}

function settleStop(store,state,emit,run,outcome,usage,turn) {
  const stop={
    trigger:run.stop?.trigger??(run.endedAt?'material':'user'),
    requestedAt:run.stop?.requestedAt??run.endedAt??run.updatedAt,
    fromState:run.stop?.fromState??null,
    outcome,terminal:turn?.terminal??null,
    runtimeExited:turn?.exited??null,settledAt:at()
  };
  const error=outcome==='unconfirmed' && stop.terminal==='completed'
    ? '执行器已返回完成回执。本轮输出已隔离，可带回草稿。'
    : stopNotices[outcome];
  emit(run,'stop_settled',stop);
  store.transition(state,emit,run,outcome==='unconfirmed'?'interrupted':'cancelled',{
    stop,usage,recovery:null,error:stop.trigger==='skill'?skillRevokedMessage+error:error
  });
}

function validateDraftScope(state,room,draft,selected) {
  if (draft.retryOf) {
    const previous=runOf(state,draft.retryOf);
    if (previous.conversation!==room.id || isLive(previous) || previous.artifact || previous.recovery) {
      throw new Problem(403,'请从本会话选择一项已结束且可重试的任务。','retry_scope');
    }
  }
  if (draft.originalBase && (!room.original || draft.base)) {
    throw new Problem(403,'请从当前原项目或本会话选用一个改稿版本。','artifact_scope');
  }
  if (draft.proposalBase && (draft.base || draft.originalBase)) {
    throw new Problem(403,'请只选一份改稿来源。','artifact_scope');
  }
  return approvedProposal(state,room,draft.proposalBase,selected);
}

function approvedProposal(state,room,base,selected) {
  if (!base) return null;
  const source=runOf(state,base);
  if (!revisableProposalIn(room,source)) {
    throw new Problem(403,'请选择本会话中可继续修改的待审稿。','proposal_scope');
  }
  if (source.endedAt) throw new Problem(410,'待审稿的材料授权已结束。','material_ended');
  memoryContext(state,source);
  if (!source.plan?.result || source.approval?.status!=='revoked' ||
      payloadHash(room.original??null)!==payloadHash(source.plan.original??null)) {
    throw new Problem(403,'待审稿与当前原项目无法核对。','proposal_scope');
  }
  authorizedMaterials(state,room.id,source.materialIds);
  if (selected && !source.materialIds.every(file=>selected.includes(file))) {
    throw new Problem(403,'继续修改待审稿需要选中原稿使用的全部授权材料。','material_scope');
  }
  return source;
}

function approvedBase(state, room, base, selected) {
  if (!base) return null;
  const record = artifactOf(state,base);
  if (record.conversation !== room.id || record.project !== room.project) {
    throw new Problem(403,'请选择这个会话和原项目里的版本。','artifact_scope');
  }
  if (record.endedAt || !record.materialIds.every(id=>selected.includes(id))) {
    throw new Problem(403,'继续改稿需要重新选中来源版本所用的全部授权材料。','material_scope');
  }
  return record;
}

function versionPeers(state,room,project,records=allArtifacts(state)) {
  const owners=new Map(state.conversations.map(item=>[item.id,item]));
  const scope=versionScope(room,project);
  return records.filter(record=>record.conversation===room.id || (project && record.receipt?.project===project &&
    versionScope(owners.get(record.conversation),project)===scope)).sort((a,b)=>a.version-b.version);
}

function handoffSource(state,bot,handoff) {
  const source=conversationOf(state,handoff.from);
  if (source.botId!==bot.id || source.revision===bot.revision ||
      botOf(state,source.botId,source.revision).kind!==bot.kind) {
    throw new Problem(403,'请选择同一个 Bot 的其他版本会话续接。','handoff_scope');
  }
  return source;
}

function existingHandoff(state,requestId,signature) {
  const room=state.conversations.find(item=>item.handoffRequest?.id===requestId);
  if (room && room.handoffRequest.signature!==signature) {
    throw new Problem(409,'此续接编号已用于另一份材料选择。','duplicate_request');
  }
  return room?.id;
}

function scriptChanges(base,result,compareMetadata) {
  const fields=['start','end','spoken','visual','subtitle',...(compareMetadata?['name','evidence']:[])];
  const shots=result.segments.flatMap((shot,index)=>{
    const before=base.segments[index];
    if(!before)return [{index,fields:['added']}];
    const differences=fields.filter(field=>payloadHash(shot[field]??null)!==payloadHash(before[field]??null));
    return differences.length?[{index,fields:differences}]:[];
  });
  return {shots,removed:Math.max(0,base.segments.length-result.segments.length),
    title:compareMetadata&&base.title!==result.title,notes:payloadHash(base.notes??[])!==payloadHash(result.notes??[])};
}

export class HyperBot {
  epoch = randomUUID();
  jobs = new Map();
  cleaning = null;
  cleanupRetryAt = 0;
  dependencyCheck = null;
  dependencyRetries = 0;
  dependencyRetryAt = 0;
  closing = false;
  runtimeChanging = false;
  constructor(store,config,workbench) {
    this.store=store;
    this.config=config;
    this.workbench=workbench;
    this.registry=new Registry(store,config);
  }

  async boot() {
    this.registry.bindLegacyDrivers();
    await this.registry.interruptVerifications();
    this.recoverRuns();
    // Expiry must abort tracked recoveries before their queued callbacks start.
    this.expire();
  }

  recoverRuns() {
    if (!this.store.read().runs.some(isLive)) return;
    const recovering=this.store.change((state,emit)=>{
      const pending=[];
      for (const run of state.runs.filter(isLive)) {
        if (['running','recovering'].includes(run.state) && !run.endedAt && hasGenerationReceipt(run)) {
          if (run.state==='running') this.store.transition(state,emit,run,'recovering');
          pending.push(run.id);
          continue;
        }
        const usage=run.usage??run.generation?.provider??null;
        delete run.generation;
        if (run.approval?.status==='pending') run.approval.status='revoked';
        if (run.state==='stopping') {
          settleStop(this.store,state,emit,run,'unconfirmed',usage);
          continue;
        }
        const recovery=run.state==='saving' && run.commitStarted && run.plan ? 'required' : null;
        const retained=!recovery && ['waiting_approval','saving'].includes(run.state) && retainUnwrittenDraft(run);
        this.store.transition(state,emit,run,'interrupted',{usage,recovery,
          error:recovery ? '上次关闭时写入结果未确认，需只读核对原项目。'
            : retained?'本机服务重启，待审分镜尚未写入。':'本机服务重启，本轮已中断。可在原会话重新发起。'
        });
      }
      return pending;
    });
    for (const id of recovering) this.track(id,signal=>this.recoverGeneration(id,signal));
  }

  index() {
    const state=this.store.read();
    const {version,conversations,runs}=state;
    const installed=installedBots(state);
    const hiddenSidebarBots=new Set(state.hiddenSidebarBots);
    const registry=this.registry.view(state);
    for (const bot of registry.bots) {
      if (bot.status==='disabled') bot.history=retiredHistorySummary(state,bot);
    }
    return {
      version,appVersion:packageInfo.version,...registry,materialRetention:true,originalWorkbench:this.config.allowOriginalWorkbench!==false,
      bots:[...registry.bots.map(bot=>{
        const builtIn=['media','brief'].includes(bot.id);
        return {...bot,category:'自媒体',...(builtIn?{subcategory:'文案',avatar:'/media/avatars/'+bot.id+'.webp'}:{}),
          ...(builtIn&&bot.revision===1&&bot.qualification==='pinned-dev'?builtInCopy[bot.id]:{})};
      }),
        ...specialistDirectory(this.config).filter(bot=>!state.bots.some(item=>item.id===bot.id))],
      groupChats:true,entityArchive:this.config.allowEntity!==false,
      installedBots:installed,sidebarBots:installed.filter(id=>!hiddenSidebarBots.has(id)),
      conversations: conversations.map(({draft,draftRetry,draftProposal,draftStamp,handoffRequest,teachingProject,trialTeachingProject,teachingTaskIds,...room})=>room)
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
      active:runs.filter(isLive).map(publicRun).at(-1) ?? null,
      pendingWriteChecks:runs.filter(needsWriteCheck).length,localDependencies:dependencyStatus(this.config)
    };
  }

  recheckDependencies() {
    if (this.dependencyCheck) return this.dependencyCheck;
    this.dependencyCheck=this.refreshDependencies().finally(()=>{this.dependencyCheck=null;});
    return this.dependencyCheck;
  }

  requireIdle(message) {
    if (this.closing || this.runtimeChanging || this.cleaning || this.registry.testing || this.jobs.size || this.store.read().runs.some(isLive)) {
      throw new Problem(409,message,'busy');
    }
  }

  applyDesktopCredential(credential,persist) {
    this.requireIdle('请等当前任务或维护操作结束后再更改模型凭据。');
    // Publish the state version in the same turn as the credential change.
    this.store.change(()=>{});
    persist();
    this.config.key=credential.key;
    this.config.provider=credential.status;
    return dependencyStatus(this.config).checks.provider;
  }

  async prepareRuntimeInstallation(id,selection,persist) {
    const message='请等当前任务或依赖检查结束后再更换本机组件。';
    this.requireIdle(message);
    const checked=selection?await inspectRuntimeInstallation(id,selection):null;
    if (checked && !checked.health.ok) throw new Problem(422,checked.health.reason,checked.health.code);
    this.requireIdle(message);
    if (this.dependencyCheck) throw new Problem(409,message,'busy');
    persist(checked?.selection??null);
    // Fence native configuration and task admission until the new Host starts.
    this.runtimeChanging=true;
  }

  async refreshDependencies() {
    const message='请等当前任务或维护操作结束后重新检查。';
    this.requireIdle(message);
    const next=await inspectDependencies(this.config);
    this.requireIdle(message);
    this.store.change(()=>{});
    Object.assign(this.config,next);
    return dependencyStatus(this.config);
  }

  recoverDependencies(now,state) {
    if (this.closing||this.runtimeChanging||this.cleaning||this.registry.testing||this.dependencyCheck||
        this.jobs.size||state.runs.some(isLive)||this.dependencyRetries>=2||now<this.dependencyRetryAt) return;
    const transient=[this.config.workbench,this.config.hermes].some(check=>
      ['revision_check_timeout','python_check_timeout'].includes(check?.code));
    if (!transient) return;
    this.dependencyRetries++;
    this.dependencyRetryAt=now+3000;
    void this.recheckDependencies().catch(()=>{});
  }

  room(id) {
    const state=this.store.read();
    const room=roomView(state,id);
    return room.draft.entityRef&&this.config.allowEntity!==false
      ? {...room,selectedEntity:draftEntityView(state,room.draft.entityRef)} : room;
  }

  memories() {return listMemories(this.store.read());}

  assertEntityScope() {
    if (this.config.allowEntity===false) throw new Problem(403,'档案目前仅在个人工作区可用。','entity_scope');
  }

  entityArchive() {this.assertEntityScope();return archiveView(this.store.read());}
  entitySources() {this.assertEntityScope();return archiveSources(this.store.read());}
  entityCandidate(key) {this.assertEntityScope();return archiveCandidate(this.store,this.store.read(),key);}

  saveEntity(raw) {
    this.assertEntityScope();
    return this.store.change(state=>saveEntityRecord(this.store,state,raw,at()));
  }

  revokeEntity(key,raw) {
    this.assertEntityScope();
    const record=this.store.change(state=>{
      if (state.runs.some(run=>run.state==='saving'&&run.entityRef?.claim_id===key)) {
        throw new Problem(409,'引用这条档案的分镜正在写入，请等写入结束。','entity_busy');
      }
      return revokeEntityRecord(state,key,raw,at());
    });
    this.expire();
    return record;
  }

  setMemoryPreference(roomId,raw) {
    const {enabled}=memoryPreference.parse(raw);
    return this.store.change(state=>{
      const room=conversationOf(state,roomId);
      room.useWorkspaceMemory=enabled;
      return {enabled};
    });
  }

  saveMemory(raw,key,revoking=false) {
    const {item,aborted}=this.store.change((state,emit)=>{
      const affected=key?state.runs.filter(run=>isLive(run)&&run.memoryRefs?.some(ref=>ref.id===key)):[];
      if (affected.some(run=>run.state==='saving')) {
        throw new Problem(409,'有引用此记忆的稿件正在写入。请等写入结束后再操作。','memory_busy');
      }
      const item=changeMemory(state,raw,key,revoking,at()), aborted=[];
      for (const run of affected) {
        if (run.state==='stopping') continue;
        if (run.approval?.status==='pending') run.approval.status='revoked';
        delete run.plan;
        if (run.generation?.provider) run.usage=run.generation.provider;
        delete run.generation;
        this.store.transition(state,emit,run,'interrupted',{error:memoryChanged.message});
        aborted.push(run.id);
      }
      return {item,aborted};
    });
    for (const id of aborted) this.jobs.get(id)?.controller.abort(memoryChanged);
    return item;
  }

  receipts(query) { return receiptReport(this.store.read(),query); }

  searchConversations(query) {
    const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('zh-CN');
    const terms=normalize(query).trim().split(/\s+/).filter(Boolean);
    const state=this.store.read();
    return state.conversations.filter(room=>{
      const bot=state.bots.find(item=>item.id===room.botId&&item.revision===room.revision)??specialistBot(room.botId,room.revision);
      const material=id=>state.materials.find(file=>file.id===id&&materialVisibleIn(file,room.id));
      const runs=state.runs.filter(run=>run.conversation===room.id&&!run.endedAt);
      const results=state.artifacts.filter(record=>record.conversation===room.id&&visibleArtifact(record,material));
      const text=normalize([room.title,room.projectTitle,bot?.name??room.botId,
        ...runs.flatMap(run=>[run.prompt,JSON.stringify(run.specialistResult?.details)]),
        ...results.map(record=>JSON.stringify(record.result)),
        ...state.materials.filter(file=>activeMaterial(file)&&materialVisibleIn(file,room.id)).map(file=>file.name)].join('\n'));
      return terms.every(term=>text.includes(term));
    }).map(room=>room.id);
  }
  recordAccounting(id,data) { return storeAccounting(this.store,id,data); }

  library(key) {
    const state=this.store.read(), records=allArtifacts(state);
    return key ? libraryMaterials(state,records,key) : libraryView(state,records);
  }

  recoveries() {
    const state=this.store.read();
    const rooms=new Map(state.conversations.map(room=>[room.id,room]));
    const materials=new Map(state.materials.map(file=>[file.id,file]));
    const artifacts=new Map(state.artifacts.map(record=>[record.id,record]));
    const checks=this.store.writeChecks.all();
    const unresolved=new Map(checks.filter(event=>event.kind==='receipt_unresolved').map(event=>[event.run,event.checkedAt]));
    const verified=new Map(checks.filter(event=>event.kind==='workbench_effects_checked').map(event=>[event.run,event.checkedAt]));
    const rows=[];
    for (const run of state.runs) {
      const room=rooms.get(run.conversation);
      if (!room || run.endedAt) continue;
      const pending=needsWriteCheck(run);
      const checkedAt=pending?unresolved.get(run.id):run.reconciled?run.updatedAt:verified.get(run.id);
      if (!pending && !checkedAt) continue;
      const material=id=>{
        const file=materials.get(id);
        return materialVisibleIn(file,room.id)?file:undefined;
      };
      const record=artifacts.get(run.artifact);
      const visible=record?.run===run.id && visibleArtifact(record,material);
      rows.push({
        id:run.id,conversation:room.id,roomTitle:room.title,projectTitle:room.projectTitle??room.title,
        botId:run.botId,botRevision:run.botRevision,original:!!room.original,state:pending?'pending':run.reconciled?'saved':'not_saved',
        startedAt:run.createdAt,checkedAt:checkedAt??null,
        artifact:visible?{id:record.id,version:record.version,conversation:record.conversation}:null,
        registered:!pending&&!run.reconciled?run.originalRegistered:null,
        files:run.materialIds.map(material).filter(activeMaterial).map(({id,name})=>({id,name}))
      });
    }
    rows.sort((a,b)=>Number(b.state==='pending')-Number(a.state==='pending') || b.startedAt.localeCompare(a.startedAt));
    return {rows};
  }

  installBot(raw) {
    const {botId}=installInput.parse(raw);
    return this.store.change(state=>{
      const bot=state.bots.filter(item=>item.id===botId&&item.status==='enabled')
        .sort((a,b)=>b.revision-a.revision)[0]??(!state.bots.some(item=>item.id===botId)?specialistBot(botId,1):undefined);
      if (!bot) throw new Problem(404,'没有可添加的 Bot 版本。','not_found');
      const existing=state.conversations.filter(room=>room.botId===botId)
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      state.installedBots=[...new Set([...installedBots(state),botId])];
      if(state.hiddenSidebarBots)state.hiddenSidebarBots=state.hiddenSidebarBots.filter(id=>id!==botId);
      if (existing) return {id:existing.id};
      const room=makeConversation(bot,bot.name+'对话');
      state.conversations.push(room);
      return {id:room.id};
    });
  }

  removeSidebarBot(raw) {
    const {botId}=installInput.parse(raw);
    return this.store.change(state=>{
      if(!installedBots(state).includes(botId))throw new Problem(404,'侧栏中没有这个 Bot。','not_found');
      state.hiddenSidebarBots=[...new Set([...(state.hiddenSidebarBots??[]),botId])];
      return {ok:true};
    });
  }

  async open(raw) {
    const input=roomInput.parse(raw);
    const snapshot=this.store.read(), {handoff}=input;
    const signature=handoff?payloadHash(input):null;
    const replay=handoff&&existingHandoff(snapshot,handoff.requestId,signature);
    if (replay) return replay;
    const candidate=botOf(snapshot,input.botId,input.revision);
    if (candidate.status!=='enabled') throw new Problem(409,'这个 Bot 版本还未启用。');
    if(['teaching','workbench'].includes(candidate.kind)&&(input.example||handoff||input.simulation)){
      throw new Problem(422,'请从专项 Bot 会话打开任务。','specialist_scope');
    }
    if (input.project && candidate.kind!=='script') throw new Problem(422,'此 Bot 使用 Hyper Bot 内部成果库。');
    if ((input.projectScope && (!input.project || !input.projectStorage || input.example)) ||
        (!input.projectScope && input.projectStorage)) {
      throw new Problem(422,'请从独立工作台选取一个已有项目。');
    }
    if (input.projectScope && this.config.allowOriginalWorkbench===false) {
      throw new Problem(403,'独立工作台项目只在个人工作区可用。','workspace_scope');
    }
    if (handoff && (input.project || input.example || input.simulation)) {
      throw new Problem(422,'续接沿用来源会话的项目和材料用途。','handoff_scope');
    }
    const from=handoff?handoffSource(snapshot,candidate,handoff):null;
    if (from) authorizedMaterials(snapshot,from.id,handoff.materials);
    const project=from?.project??input.project;
    const simulation=from?.simulation??input.simulation;
    let destination;
    if (project) {
      if (from?.original || input.projectScope==='original') {
        destination=await this.workbench.original.bind(project,from?.original?.storage??input.projectStorage);
      } else destination=(await this.workbench.list()).find(row=>row.id===project);
      if (!destination || destination.simulation!==simulation ||
          (from?.original && versionScope(destination,project)!==versionScope(from,project))) {
        throw new Problem(409,'所选原项目已变更。请重新选择。','workbench_conflict');
      }
    }
    return this.store.change(state=>{
      const replay=handoff&&existingHandoff(state,handoff.requestId,signature);
      if (replay) return replay;
      const bot=botOf(state,input.botId,input.revision);
      if (bot.status!=='enabled') throw new Problem(409,'这个 Bot 版本还未启用。');
      const room=makeConversation(bot,input.title,{project,title:destination?.title??input.title,
        simulation:input.example || simulation,original:destination?.original});
      if (input.example && project && !simulation) throw new Problem(422,'合成材料需使用演练项目。');
      if (from) {
        const current=handoffSource(state,bot,handoff);
        if (current.project!==from.project || versionScope(current,current.project)!==versionScope(from,from.project)) {
          throw new Problem(409,'来源会话的项目已更新。请重新打开续接。','workbench_conflict');
        }
        const files=authorizedMaterials(state,current.id,handoff.materials);
        this.store.requireLinkedMaterialSupport();
        for (const file of files) (file.sharedWith??=[]).push(room.id);
        room.continuedFrom={id:current.id,revision:current.revision};
        room.handoffRequest={id:handoff.requestId,signature};
        room.draft={...initialDraft(),attachments:handoff.materials};
      }
      state.conversations.push(room);
      if (input.example) {
        const {prompt,materials}=materializeExample(bot);
        for (const file of materials) {
          state.materials.push({...file,conversation:room.id,authorizedAt:at(),digest:sha(file.content),nature:'simulation'});
        }
        room.draft={text:prompt,attachments:materials.map(file=>file.id),base:null};
      }
      return room.id;
    });
  }

  originalRoom(roomId) {
    const room=conversationOf(this.store.read(),roomId);
    if (!room.original) throw new Problem(404,'此会话依属 Hyper Bot 管理的工作区。','not_found');
    return room;
  }

  originalContents(roomId) {
    return this.workbench.original.contents(this.originalRoom(roomId));
  }

  async importOriginalMaterial(roomId,raw) {
    const input=projectMaterialInput.parse(raw);
    const room=this.originalRoom(roomId);
    const file=await this.workbench.original.material(room,input.source,input.digest);
    return this.storeMaterial(roomId,file);
  }

  upload(roomId,raw) {
    const file=fileInput.parse(raw);
    if (Buffer.byteLength(file.content)>64000) throw new Problem(413,'单份文本最多 64 KB。');
    return this.storeMaterial(roomId,file);
  }

  storeMaterial(roomId,file) {
    return this.store.change(state=>{
      const room=conversationOf(state,roomId),bot=botOf(state,room.botId,room.revision);
      if (bot.status!=='enabled') throw new Problem(409,'此版本已停用。');
      const content=room.original && !file.originalSource ? file.content.replace(/\r\n?/g,'\n') : file.content;
      const hash=sha(content);
      const prior=state.materials.find(m=>materialVisibleIn(m,room.id)&&m.digest===hash&&m.name===file.name&&
        m.originalSource?.id===file.originalSource?.id&&activeMaterial(m));
      if (prior) return prior.id;
      const record={name:file.name,content,id:randomUUID(),conversation:room.id,
        digest:hash,authorizedAt:at(),nature:room.simulation?'simulation':'provided',
        ...(file.originalSource?{originalSource:file.originalSource}:{})};
      state.materials.push(record);
      return record.id;
    });
  }

  source(roomId,materialId) {
    const state=this.store.read(), room=conversationOf(state,roomId);
    const [file]=authorizedMaterials(state,room.id,[materialId]);
    return {...materialMetadata(file),content:file.content};
  }

  setDeadline(roomId,materialId,raw) {
    const {expiresAt}=deadlineInput.parse(raw);
    if (expiresAt && Date.parse(expiresAt)<=Date.now()) {
      throw new Problem(422,'请选择未来的授权时间。','material_deadline');
    }
    return this.store.change(state=>{
      const [file]=authorizedMaterials(state,roomId,[materialId]);
      file.expiresAt=expiresAt;
      return {expiresAt};
    });
  }

  revokeMaterial(roomId,materialId,raw) {
    revokeInput.parse(raw);
    const {record,abort}=this.store.change((state,emit)=>{
      const file=materialIn(state,roomId,materialId);
      if (file.endedAt) return {record:file,abort:[]};
      const reason=expiredMaterial(file)?'expired':'revoked';
      return retireMaterial(this.store,state,emit,file,reason,at());
    });
    this.abortForMaterials(abort);
    this.scheduleCleanup();
    return materialMetadata(record);
  }

  revokeSkill(id,raw) {
    revokeInput.parse(raw);
    const {revokedAt,abort,abortVerification}=this.store.change((state,emit)=>{
      const {revokedAt,affected}=this.registry.revokeSkillIn(state,emit,id);
      const keys=new Set(affected.map(bot=>bot.id+'/'+bot.revision));
      const abort=[];
      for (const run of state.runs.filter(isLive)) {
        if (!keys.has(run.botId+'/'+run.botRevision)) continue;
        if (['queued','running','recovering'].includes(run.state)) {
          recordStopRequest(run,emit,'skill','maintainer');
          this.store.transition(state,emit,run,'stopping',{error:skillRevokedMessage});
        } else if (run.state==='saving' && !run.commitStarted) {
          this.store.transition(state,emit,run,'interrupted',{error:skillRevokedMessage});
        } else continue;
        abort.push(run.id);
      }
      return {revokedAt,abort,abortVerification:keys.has(this.registry.testing)};
    });
    const reason=new Problem(409,skillRevokedMessage,'skill_revoked');
    for (const id of abort) this.jobs.get(id)?.controller.abort(reason);
    if (abortVerification) this.registry.controller?.abort(reason);
    return {revokedAt};
  }

  saveDraft(roomId,raw) {
    const {draftToken:expected,...draft}=draftSaveInput.parse(raw);
    return this.store.change(state=>{
      const room=conversationOf(state,roomId);
      checkDraftToken(room,expected);
      authorizedMaterials(state,room.id,draft.attachments);
      if (draft.entityRef) {
        this.assertEntityScope();
        validateEntitySelection(state,room,draft.entityRef);
      }
      validateDraftScope(state,room,draft);
      if (draft.base && artifactOf(state,draft.base).endedAt) {
        throw new Problem(410,'此稿件的材料授权已结束。','material_ended');
      }
      setRoomDraft(room,draft);
      return {draftToken:draftToken(room),snapshotVersion:state.version+1};
    });
  }

  async start(roomId,raw) {
    const {draftToken:expected,...input}=runInput.parse(raw);
    // The draft token guards a new write. A replay keeps the original request identity.
    const signature=payloadHash({roomId,...input});
    const priorRun=state=>state.runs.find(row=>row.clientRequestId===input.clientRequestId);
    const initial=this.store.read();
    const selected=conversationOf(initial,roomId);
    if(['teaching','workbench'].includes(botOf(initial,selected.botId,selected.revision).kind)){
      throw new Problem(422,'请使用专项 Bot 的任务入口。','specialist_scope');
    }
    if (!priorRun(initial) && !initial.runs.some(isLive) && !this.registry.testing) {
      const bot=botOf(initial,selected.botId,selected.revision);
      if (bot.status==='enabled' && !botBlock(initial,this.config,bot)) {
        try { await this.registry.checkSources(bot); }
        catch (error) { if (!priorRun(this.store.read())) throw error; }
      }
    }
    const {run,newly} = this.store.change((state,emit)=>{
      const prior=priorRun(state);
      if (prior) {
        if (prior.signature!==signature) throw new Problem(409,'此发送编号已用于另一条任务。','duplicate_request');
        return {run:prior,newly:false};
      }
      if (this.closing || this.runtimeChanging) throw new Problem(503,'本机服务正在应用组件设置。','runtime_restarting');
      if (state.runs.some(isLive) || this.registry.testing) throw new Problem(409,'正在处理一轮任务。草稿可保留。','busy');
      const room=conversationOf(state,roomId);
      checkDraftToken(room,expected);
      const bot=botOf(state,room.botId,room.revision);
      if (bot.status!=='enabled') throw new Problem(409,'该 Bot 版本已停用。历史仍可打开。','bot_disabled');
      const blocked=botBlock(state,this.config,bot);
      if (blocked) throw new Problem(503,blocked,'dependency_unavailable');
      if (input.useWorkspaceMemory!==undefined && input.useWorkspaceMemory!==(room.useWorkspaceMemory===true)) {
        throw new Problem(409,'会话的记忆设置已变化，请刷新后重新发送。','memory_preference');
      }
      const memoryRefs=input.useWorkspaceMemory?memoryRefsFor(state,bot.id):[];
      if (input.entityRef) this.assertEntityScope();
      const createdAt=at();
      const entityAccess=grantEntityRead(state,room,input.entityRef,createdAt,this.config.upstream);
      approvedMethodsForRun(state,bot);
      const files=authorizedMaterials(state,room.id,input.attachments);
      const scope=versionScope(room,room.project);
      if ((bot.kind==='script' && this.cleaning) || state.materials.some(file=>file.cleanup==='pending' &&
          (materialVisibleIn(file,room.id) || (room.project && state.conversations.some(other=>
            other.project===room.project && versionScope(other,other.project)===scope && materialVisibleIn(file,other.id)))))) {
        throw new Problem(409,'原项目正在清理已撤回或到期的材料。完成后可继续。','material_cleanup');
      }
      if (files.length < (bot.kind==='brief'?2:1)) {
        throw new Problem(422, bot.kind==='brief'?'请选择至少两份授权文字材料。':'请选择文字材料，再发送口播任务。');
      }
      if (state.runs.some(run=>needsWriteCheck(run) && (run.conversation===room.id ||
          (room.project && run.plan.project===room.project &&
            versionScope(conversationOf(state,run.conversation),run.plan.project)===scope)))) {
        throw new Problem(409,'请从「断线核对」先确认原项目的上一次写入。','recovery_required');
      }
      const proposal=validateDraftScope(state,room,input,input.attachments);
      const base=input.base??proposal?.base??null;
      const originalBase=input.originalBase??(proposal?.unwrittenDraft?undefined:proposal?.originalBase);
      approvedBase(state,room,base,input.attachments);
      const baseRun=base&&runOf(state,artifactOf(state,base).run);
      if ([baseRun?.entityRef,proposal?.entityRef].some(ref=>ref&&!sameEntityRef(ref,input.entityRef))) {
        throw new Problem(409,'这份续改稿使用了档案，请重新选择原引用，或移除续改来源后发送。','entity_follow_up');
      }
      const run={id:randomUUID(),conversation:roomId,botId:bot.id,botRevision:bot.revision,driver:bot.driver,driverRevision:bot.driverRevision,
        kind:bot.kind,signature,clientRequestId:input.clientRequestId,base,prompt:input.text,
        materialIds:input.attachments,createdAt,updatedAt:createdAt,state:'queued',usage:unusedMeter(),recovery:null,
        model:this.config.model,modelMode:upstreamMode(this.config),...(bot.workflow?{workflow:bot.workflow}:{}),
        ...(this.config.allowEntity!==false?{entityActor:entityOwner(state,createdAt).entity_id}:{}),
        ...entityAccess,
        ...(memoryRefs.length?{memoryRefs}:{}),
        ...(input.retryOf?{retryOf:input.retryOf}:{}),
        ...(originalBase?{originalBase}:{}),...(proposal?{proposalBase:proposal.id}:{})};
      state.runs.push(run);
      room.updatedAt=run.createdAt;
      setRoomDraft(room,initialDraft());
      run.followUpDraftStamp=room.draftStamp;
      emit(run,'accepted',{state:'queued',driverRevision:run.driverRevision,materialIds:run.materialIds,base:run.base,retryOf:run.retryOf??null,role:'user',
        ...(run.proposalBase?{proposalBase:run.proposalBase}:{}),
        ...(run.workflow?{workflow:run.workflow}:{})});
      return {run,newly:true};
    });
    if (newly) this.track(run.id,signal=>this.generate(run.id,signal));
    return publicRun(run);
  }

  startTeachingAssistant(roomId,raw) {
    const input=teachingAssistantInput.parse(raw);
    const signature=payloadHash({roomId,input});
    const {run,fresh}=this.store.change((state,emit)=>{
      const room=conversationOf(state,roomId);
      const bot=botOf(state,room.botId,room.revision);
      if(bot.kind!=='teaching'||bot.target!=='bot'||this.config.teachingAccess==='teacher') {
        throw new Problem(404,'当前会话没有本机教培任务助手。','teaching_scope');
      }
      const prior=state.runs.find(item=>item.clientRequestId===input.requestId);
      if(prior){
        if(prior.signature!==signature)throw new Problem(409,'这个任务编号已用于不同任务。','duplicate_request');
        return {run:prior,fresh:false};
      }
      if(this.closing||this.runtimeChanging||this.cleaning||this.registry.testing||state.runs.some(isLive)){
        throw new Problem(409,'请等当前工作区任务结束后再发送。','busy');
      }
      const credential=dependencyStatus(this.config).checks.provider;
      if(!credential.ok)throw new Problem(503,credential.reason,'dependency_unavailable');
      const now=at();
      const run={id:randomUUID(),clientRequestId:input.requestId,signature,conversation:roomId,botId:bot.id,
        botRevision:bot.revision,kind:bot.kind,driver:'deepseek',prompt:input.text,materialIds:[],teachingEvidence:input.evidence,
        createdAt:now,updatedAt:now,state:'queued',usage:unusedMeter(),recovery:null,
        model:this.config.model,modelMode:upstreamMode(this.config)};
      state.runs.push(run);
      room.updatedAt=now;
      emit(run,'accepted',{role:'user',state:'queued'});
      return {run,fresh:true};
    });
    if(fresh)this.track(run.id,signal=>this.runTeachingAssistant(run,signal));
    return publicRun(run);
  }

  async runTeachingAssistant(job,signal) {
    let usage;
    try {
      signal.throwIfAborted();
      this.store.change((state,emit)=>this.store.transition(state,emit,runOf(state,job.id),'running'));
      const history=this.store.read().runs.filter(row=>row.conversation===job.conversation&&row.state==='succeeded'&&row.teachingReply).slice(-3);
      const teachingReply=await generateTeachingReply(this.config,history,job,signal,value=>{usage=value;});
      signal.throwIfAborted();
      this.store.change((state,emit)=>this.store.transition(state,emit,runOf(state,job.id),'succeeded',{teachingReply,usage}));
    } catch(error){
      this.generationFailed(job.id,error,signal,usage);
    }
  }

  getMediaRoom(roomId,state=this.store.read()) {
    const room=conversationOf(state,roomId);
    const bot=botOf(state,room.botId,room.revision);
    if(bot.kind!=='workbench')throw new Problem(404,'本会话没有自媒体专项工作台。','specialist_scope');
    return {room,bot};
  }

  async uploadSpecialist(roomId,name,request) {
    const {room,bot}=this.getMediaRoom(roomId);
    if(!bot.uploads)throw new Problem(422,'此 Bot 使用授权文字输入。','specialist_input');
    if(bot.mode==='text'&&!/\.(txt|md|csv|json)$/i.test(name)) {
      throw new Problem(422,'文字 Bot 接收 TXT、Markdown、CSV 或 JSON。','specialist_input');
    }
    if((room.specialistUploads??[]).length>=8) throw new Problem(422,'每次最多添加 8 份待登记素材。','specialist_input');
    const file=await saveWorkbenchUpload(this.config.data,roomId,name,request);
    try {
      return this.store.change(state=>{
        const {room}=this.getMediaRoom(roomId,state);
        const files=room.specialistUploads??=[];
        if(files.length>=8) throw new Problem(422,'每次最多添加 8 份待登记素材。','specialist_input');
        files.push(file);
        return file;
      });
    } catch(error) {
      await discardWorkbenchUpload(workbenchUploadPath(this.config.data,roomId,file));
      throw error;
    }
  }

  async removeSpecialistUpload(roomId,id) {
    const file=this.store.change(state=>{
      const {room}=this.getMediaRoom(roomId,state);
      if(state.runs.some(run=>run.conversation===roomId&&isLive(run))) {
        throw new Problem(409,'素材正在登记。','busy');
      }
      const pending=room.specialistUploads??[];
      const item=pending.find(file=>file.id===id);
      if(!item) throw new Problem(404,'此素材已登记或移除。','not_found');
      room.specialistUploads=pending.filter(file=>file.id!==id);
      return item;
    });
    await discardWorkbenchUpload(workbenchUploadPath(this.config.data,roomId,file));
    return {};
  }

  startSpecialist(roomId,raw) {
    const input=specialistInput.parse(raw);
    const signature=payloadHash({roomId,input});
    const {room,bot,job,fresh}=this.store.change((state,emit)=>{
      const {room,bot}=this.getMediaRoom(roomId,state);
      const prior=state.runs.find(run=>run.clientRequestId===input.requestId);
      if(prior) {
        if(prior.signature!==signature)throw new Problem(409,'这个任务编号已用于不同任务。','duplicate_request');
        return {room,bot,job:prior,fresh:false};
      }
      if(this.closing||this.runtimeChanging||this.cleaning||this.registry.testing||state.runs.some(isLive)) {
        throw new Problem(409,'请等当前工作区的任务或维护结束。','busy');
      }
      const available=specialistDirectory(this.config).find(entry=>entry.id===bot.id);
      if(available?.blocked)throw new Problem(503,available.blocked,'dependency_unavailable');
      const now=at();
      const job={id:randomUUID(),clientRequestId:input.requestId,signature,conversation:roomId,botId:bot.id,
        botRevision:bot.revision,kind:bot.kind,driver:bot.model?'dsh-web':'workbench',driverRevision:bot.revision,
        prompt:input.text,materialIds:[],specialistInput:input,specialistFiles:room.specialistUploads??[],
        state:'queued',createdAt:now,updatedAt:now,usage:unusedMeter(),recovery:null,
        ...(bot.model?{model:this.config.model,modelMode:upstreamMode(this.config)}:{})};
      state.runs.push(job);
      room.updatedAt=now;
      emit(job,'accepted',{role:'user',state:'queued',capability:bot.id});
      return {room,bot,job,fresh:true};
    });
    if(fresh)this.track(job.id,signal=>this.runSpecialist(bot,room,job,signal));
    return publicRun(job);
  }

  async runSpecialist(bot,room,job,signal) {
    let usage;
    try {
      signal.throwIfAborted();
      this.store.change((state,emit)=>this.store.transition(state,emit,runOf(state,job.id),'running'));
      const result=await runMediaSpecialist({bot,room,job,signal,config:this.config,workbench:this.workbench,onUsage:value=>{usage=value;},
        onIntake:({project,task})=>this.store.change((state,emit)=>{
          const run=runOf(state,job.id),current=conversationOf(state,room.id);
          if(current.project&&current.project!==project)throw new Problem(409,'工作台绑定已变化。','workbench_conflict');
          current.project=project;
          current.specialistUploads=(current.specialistUploads??[]).filter(file=>!job.specialistFiles.some(sent=>sent.id===file.id));
          Object.assign(run,{project,workbenchTask:task});
          emit(run,'workbench_intake',{project,task});
        })});
      signal.throwIfAborted();
      this.store.change((state,emit)=>this.store.transition(state,emit,runOf(state,job.id),'succeeded',
        {specialistResult:result,...(usage?{usage}:{})}));
    } catch(error) {
      this.generationFailed(job.id,error,signal,usage);
    }
  }

  specialistFile(roomId,runId,name) {
    const state=this.store.read();
    this.getMediaRoom(roomId,state);
    const run=runOf(state,runId);
    const file=run.conversation===roomId&&run.specialistResult?.files?.find(item=>item.name===name);
    if(!file||!projectId.test(run.project)||!projectId.test(file.export??file.media)) {
      throw new Problem(404,'找不到已完成的本机成果。','not_found');
    }
    return {route:'/api/projects/'+run.project+(file.media?'/media/'+file.media+'/original':
      '/exports/'+file.export+'/'+encodeURIComponent(file.name)),name:file.name};
  }

  track(id,callback) {
    const controller=new AbortController();
    const done=Promise.resolve().then(()=>callback(controller.signal)).catch(error=>{
      // Expected failures are recorded in generate/save. Keep the host observable if storage fails.
      console.error('Hyper Bot task record:',error?.code ?? error?.name ?? 'error');
    }).finally(()=>{this.jobs.delete(id);this.scheduleCleanup();});
    this.jobs.set(id,{controller,done});
  }

  async generate(id,signal) {
    let usage=null;
    try {
      const state=this.store.read(), run=runOf(state,id), room=conversationOf(state,run.conversation);
      if (signal.aborted || run.state==='stopping') throw signal.reason ?? new Error('stopping');
      const bot=botOf(state,run.botId,run.botRevision);
      const methods=approvedMethodsForRun(state,bot);
      const materials=authorizedMaterials(state,room.id,run.materialIds);
      const base=approvedBase(state,room,run.base,run.materialIds);
      const proposal=approvedProposal(state,room,run.proposalBase,run.materialIds);
      this.store.change((next,emit)=>this.store.transition(next,emit,runOf(next,id),'running'));
      const workflow=methods.workflow?await methods.workflow.instructions(this.config,signal):undefined;
      let prepared;
      if (bot.kind==='script') {
        prepared=await this.workbench.prepare(room,run,materials,signal,(project,workbenchTask)=>{
          this.store.change((next,emit)=>{
            const conv=conversationOf(next,room.id),job=runOf(next,id);
            if (conv.project && project!==conv.project) throw new Problem(409,'运行期间项目绑定已变化。');
            conv.project=project;
            job.project=project;
            if(workbenchTask)job.workbenchTask=workbenchTask;
            emit(job,workbenchTask?'workbench_intake':'project_bound',{project,workbenchTask});
          });
        });
      }
      signal.throwIfAborted();
      const current=this.store.read();
      const memory=memoryContext(current,run);
      const entity=entityContext(current,run,this.config.upstream);
      const prompt=definitionPrompt({kind:bot.kind,skills:methods.skills,workflow,request:run.prompt,memory,
        entity,materials,base:proposal?.plan.result ?? base?.result ?? prepared?.base,conversationTitle:room.title});
      const output=await execute(this.config,bot.driver,id,prompt,signal,(session,dshRequest)=>{
        this.store.change((next,emit)=>{
          signal.throwIfAborted();
          const job=runOf(next,id);
          authorizedMaterials(next,room.id,job.materialIds);
          job.engineSession=session;
          job.generation={version:1,driverRevision:run.driverRevision,materials:materialSignature(materials),
            preparation:preparationReceipt(prepared),promptDigest:sha(prompt),dshRequest};
          emit(job,'engine_started',{engineSession:session,driver:bot.driver});
        });
      },record=>{usage=record;},record=>this.noteProvider(id,record,true),record=>this.noteProvider(id,record,false),
      retry=>this.store.change((next,emit)=>{
        signal.throwIfAborted();
        emit(runOf(next,id),'runtime_start_retry',retry);
      }));
      signal.throwIfAborted();
      const result=resultOf(bot.kind,output,materials,run.prompt);
      this.store.change((next,emit)=>{
        const job=runOf(next,id);
        authorizedMaterials(next,room.id,job.materialIds);
        job.usage=usage;
        job.generation.result=result;
        emit(job,'generation_verified',{engineSession:job.engineSession});
      });
      await this.finishGeneration(run,result,prepared,materials,usage,signal,false);
    } catch(error) {
      this.generationFailed(id,error,signal,usage);
    }
  }

  noteProvider(id,record,terminal) {
    this.store.change((state,emit)=>{
      const run=runOf(state,id);
      if (run.state!=='running' || run.endedAt || !run.generation) {
        if (!terminal) throw new Problem(409,'本轮任务已停止或授权已结束。','state_conflict');
        if (run.state==='stopping' || run.stop) {
          emit(run,'provider_completed_after_stop',{usage:record});
        }
        return;
      }
      if (!terminal) entityContext(state,run,this.config.upstream);
      run.usage=record;
      if (!terminal && run.memoryRefs?.length) run.memoryReceipt=run.memoryRefs;
      if (!terminal && run.entityRef) run.entityReceipt={...run.entityRef};
      if (terminal) run.generation.provider=record;
      emit(run,terminal?'provider_completed':'provider_requested',{usage:record,
        ...(!terminal&&run.entityReceipt?{entity:run.entityReceipt,grant:run.entityGrant.grant_id}:{})});
    });
  }

  async recoverGeneration(id,signal) {
    try {
      const state=this.store.read(),run=runOf(state,id),room=conversationOf(state,run.conversation);
      signal.throwIfAborted();
      const proof=run.generation;
      const materials=authorizedMaterials(state,room.id,run.materialIds);
      memoryContext(state,run);
      entityContext(state,run,this.config.upstream);
      approvedBase(state,room,run.base,run.materialIds);
      approvedProposal(state,room,run.proposalBase,run.materialIds);
      if (!hasGenerationReceipt(run) || proof.driverRevision!==DRIVERS[run.driver]?.revision ||
          proof.materials!==materialSignature(materials) || (run.kind==='script'&&!proof.preparation)) {
        throw new Problem(409,'本轮执行记录与已授权材料无法核对。','generation_unverified');
      }
      const bot=botOf(state,run.botId,run.botRevision);
      if (run.workflow||bot.workflow) {
        const {workflow}=approvedMethodsForRun(state,bot);
        if (!workflow || run.workflow?.id!==workflow.id || run.workflow.digest!==workflow.digest) {
          throw new Problem(409,'本轮执行记录的自带流程无法核对。','generation_unverified');
        }
        await workflow.instructions(this.config,signal);
      }
      const prepared=restorePreparation(proof.preparation,room,materials);
      const output=proof.result?JSON.stringify(proof.result):await recoverWebText(this.config.data,run,signal);
      signal.throwIfAborted();
      const result=resultOf(run.kind,output,materials,run.prompt);
      await this.finishGeneration(run,result,prepared,materials,run.usage??proof.provider,signal,true);
    } catch(error) {
      this.generationFailed(id,error,signal);
    }
  }

  async finishGeneration(run,result,prepared,materials,usage,signal,recovered) {
    const plan=prepared ? await this.workbench.proposal(prepared,run,result,materials,signal) : null;
    signal.throwIfAborted();
    this.store.change((state,emit)=>{
      const current=runOf(state,run.id);
      authorizedMaterials(state,run.conversation,current.materialIds);
      memoryContext(state,current);
      entityContext(state,current,this.config.upstream);
      if (current.state!==(recovered?'recovering':'running')) throw new Problem(409,'本轮任务状态已变化。','state_conflict');
      delete current.generation;
      if (plan && botOf(state,run.botId,run.botRevision).status!=='enabled') {
        return this.store.transition(state,emit,current,'interrupted',{error:'Bot 版本已停用。',usage});
      }
      if (recovered) {
        current.engineRecovered=true;
        emit(current,'generation_recovered',{engineSession:current.engineSession,method:run.generation.result?'checkpoint':'dsh_transcript'});
      }
      if (plan) {
        const room=conversationOf(state,current.conversation);
        const peers=versionPeers(state,room,plan.project);
        const source=approvedBase(state,room,current.base,current.materialIds);
        const proposal=approvedProposal(state,room,current.proposalBase,current.materialIds);
        const base=proposal?.plan.result ?? source?.result ?? prepared.base;
        const projectHead=plan.body.supersedes && peers.find(version=>version.receipt?.id===plan.body.supersedes);
        const review={version:(peers.at(-1)?.version??0)+1,sourceVersion:source?.version??null,
          headVersion:projectHead?.version??null,changes:base?scriptChanges(base,result,!!(source||proposal)):null};
        const approval={id:randomUUID(),epoch:this.epoch,digest:plan.digest,expiresAt:Date.now()+15*60*1000,status:'pending',review};
        this.store.transition(state,emit,current,'waiting_approval',{plan,approval,usage});
      } else this.accept(state,emit,current,result,null,usage);
    });
  }

  generationFailed(id,error,signal,usage) {
    this.store.change((state,emit)=>{
      const run=runOf(state,id);
      usage??=run.usage??run.generation?.provider??null;
      const generated=!!run.generation?.result;
      delete run.generation;
      if (run.state==='stopping') {
        const turn=error instanceof RuntimeStop?error.turn:null;
        const outcome=run.stop?.fromState==='recovering'?'readback_stopped'
          : turn?.terminal==='cancelled'?'confirmed'
          : !run.engineSession || turn?.submitted===false?'before_prompt'
          : generated?'generation_discarded':'unconfirmed';
        settleStop(this.store,state,emit,run,outcome,usage,turn??(generated?{terminal:'completed',exited:true}:null));
      } else if (signal.aborted) {
        if (isLive(run)) this.store.transition(state,emit,run,'interrupted',{usage,error:'本机服务已退出。'});
      } else if (run.state==='queued' || run.state==='recovering') {
        const notice=run.state==='queued'?'本轮未启动。':'找回结果失败。本轮已中断。';
        this.store.transition(state,emit,run,'interrupted',{usage,error:error instanceof Problem?error.message:notice});
      } else if (run.state==='running') {
        this.store.transition(state,emit,run,'failed',{usage,error:error instanceof Problem?error.message:'运行时未完成本轮。'});
      }
    });
  }

  accept(state,emit,run,result,receipt,usage=run.usage) {
    const room=conversationOf(state,run.conversation);
    const records=allArtifacts(state);
    if (records.some(record=>record.run===run.id)) throw new Problem(409,'当前任务已登记成果。');
    const peers=versionPeers(state,room,receipt?.project,records);
    const previous=receipt?.supersedes ? peers.find(a=>a.receipt?.id===receipt.supersedes) : peers.at(-1);
    const artifact={id:randomUUID(),run:run.id,conversation:room.id,botId:run.botId,botRevision:run.botRevision, kind:run.kind,
      project:room.project,version:(peers.at(-1)?.version??0)+1,
      previous:previous?.id??null,base:run.base,receipt,result,materialIds:run.materialIds,createdAt:at(),
      ...(run.proposalBase?{proposalBase:run.proposalBase}:{}),
      ...(run.plan?.timing?{timing:run.plan.timing}:{}),
      ...(room.original?{originalStorage:room.original.storage}:{})};
    if (run.endedAt) state.retiredArtifacts.push(hidesArtifact(artifact,run.endedAt));
    else state.artifacts.push(artifact);
    const patch={artifact:artifact.id,usage,recovery:null,error:null};
    // Recovery adds a receipt to the finished run without reopening its state machine.
    if (run.state==='interrupted') {
      Object.assign(run,patch,{updatedAt:at(),reconciled:true});
      emit(run,'receipt_recovered',{artifact:artifact.id,project:receipt.project,workbenchArtifact:receipt.id});
    } else this.store.transition(state,emit,run,'succeeded',patch);
    room.updatedAt=at();
  }

  pendingApproval(state,emit,run,input) {
    const a=run.approval;
    if (run.state!=='waiting_approval' || !a || a.status!=='pending' ||
        a.id!==input.id || a.digest!==input.digest || a.epoch!==this.epoch) {
      throw new Problem(409,'该授权已失效或只属于另一项任务。','approval_scope');
    }
    const room=conversationOf(state,run.conversation);
    authorizedMaterials(state,room.id,run.materialIds);
    memoryContext(state,run);
    entityContext(state,run,this.config.upstream);
    const expired=a.expiresAt<=Date.now();
    const matches=botOf(state,run.botId,run.botRevision).status==='enabled' && room.project===run.plan.project &&
      payloadHash(room.original??null)===payloadHash(run.plan.original??null) && planDigest(run.plan)===a.digest;
    if (expired || !matches) {
      a.status='revoked';
      const retained=expired&&matches&&retainUnwrittenDraft(run);
      this.store.transition(state,emit,run,'interrupted',{error:retained?'写入审批已过期，分镜尚未写入。':'本轮授权已失效，可在原项目重新生成。'});
      return null;
    }
    return room;
  }

  returnProposal(runId,raw) {
    const input=revisionInput.parse(raw);
    const outcome=this.store.change((state,emit)=>{
      const run=runOf(state,runId),room=conversationOf(state,run.conversation),a=run.approval;
      const matches=a?.id===input.id && a.digest===input.digest;
      if (matches && (run.returnedForRevision||run.unwrittenDraft) &&
          room.draftProposal?.id===run.id && room.draftProposal.stamp===room.draftStamp) {
        approvedProposal(state,room,run.id);
        return 'editing';
      }
      const restore=matches&&run.unwrittenDraft===true;
      if (restore) approvedProposal(state,room,run.id);
      else if (!this.pendingApproval(state,emit,run,input)) return 'expired';
      checkDraftToken(room,input.draftToken);
      const {text,attachments}=room.draft??initialDraft();
      authorizedMaterials(state,room.id,attachments);
      setRoomDraft(room,{text,attachments:attachments.length?attachments:run.materialIds,base:null,proposalBase:run.id,
        ...(restore?{retryOf:run.id}:{})});
      room.updatedAt=at();
      if (restore) {
        emit(run,'proposal_restored',{role:'user',project:run.plan.project});
        return 'editing';
      }
      a.status='revoked';
      emit(run,'approval',{role:'user',decision:'returned',target:run.plan.project,digest:a.digest});
      this.store.transition(state,emit,run,'cancelled',{returnedForRevision:true,error:'写入审批已撤销，分镜已带回输入框供修改。'});
      return 'editing';
    });
    if (outcome==='expired') throw new Problem(409,'本轮授权已过期。','approval_expired');
    return outcome;
  }

  decide(runId,raw) {
    const input=approvalInput.parse(raw);
    const outcome=this.store.change((state,emit)=>{
      const run=runOf(state,runId),a=run.approval;
      if (!this.pendingApproval(state,emit,run,input)) return 'expired';
      a.status=input.allow?'accepted':'denied';
      emit(run,'approval',{role:'user',decision:a.status,target:run.plan.project,digest:a.digest});
      if (input.allow) this.store.transition(state,emit,run,'saving');
      else this.store.transition(state,emit,run,'cancelled',{error:'已拒绝写入，原项目保留已有版本。'});
      return input.allow?'accepted':'denied';
    });
    if (outcome==='expired') throw new Problem(409,'本轮授权已过期。','approval_expired');
    if (outcome==='accepted') {
      // Generation already returned its proposal, but its promise may still be in cleanup.
      const previous=this.jobs.get(runId)?.done;
      if (previous) void previous.then(()=>this.track(runId,signal=>this.save(runId,signal)));
      else this.track(runId,signal=>this.save(runId,signal));
    }
    return outcome;
  }

  async save(id,signal) {
    const {plan,state:phase}=runOf(this.store.read(),id);
    if (!plan || phase!=='saving') return;
    try {
      const receipt=await this.workbench.commit(plan,step=>{
        this.store.change((state,emit)=>{
          const job=runOf(state,id);
          if (job.state!=='saving' || job.endedAt) throw new Problem(410,'材料授权已结束。','material_ended');
          authorizedMaterials(state,job.conversation,job.materialIds);
          entityContext(state,job,this.config.upstream);
          job.commitStarted??=at();
          if (step?.submission) job.plan.submission=step.submission;
          if (step?.sources) job.originalRegistered=step.sources.length;
          if (step?.task) job.workbenchTask=step.task;
          emit(job,'workbench_submit_started',{project:plan.project,digest:plan.digest,operation:step?.kind??'artifact',
            ...(step?.material?{material:step.material}:{})});
        });
      },signal);
      this.expire();
      this.store.change((state,emit)=>this.accept(state,emit,runOf(state,id),plan.result,receipt));
    } catch(error) {
      this.store.change((state,emit)=>{
        const run=runOf(state,id);
        if (run.state!=='saving') return;
        const rejectedWrite=['workbench_conflict','workbench_validation','workbench_missing'].includes(error.code);
        if (plan.original && run.plan?.submission && rejectedWrite) run.originalNoArtifact=true;
        const rejected=!run.commitStarted || (!plan.original && rejectedWrite);
        const retained=rejected&&retainUnwrittenDraft(run);
        this.store.transition(state,emit,run,rejected?'failed':'interrupted',{
          error:retained&&error.code==='workbench_conflict'?'原项目在审批期间发生变化，本轮分镜尚未保存。':
            error instanceof Problem?error.message:'写入状态有待与原项目核对。',
          recovery:rejected||run.endedAt?null:'required'
        });
      });
    }
  }

  stop(id) {
    this.store.change((state,emit)=>{
      const run=runOf(state,id);
      if (!['queued','running','recovering','waiting_approval'].includes(run.state)) {
        throw new Problem(409,'当前状态不能停止。','state_conflict');
      }
      recordStopRequest(run,emit,'user','user');
      if (run.state==='waiting_approval') {
        run.approval.status='revoked';
        settleStop(this.store,state,emit,run,'approval_revoked',run.usage);
      } else this.store.transition(state,emit,run,'stopping');
    });
    this.jobs.get(id)?.controller.abort(new Error('Run stopped by user'));
  }

  async recover(id) {
    const before=runOf(this.store.read(),id);
    if (!needsWriteCheck(before)) {
      throw new Problem(409,'本轮没有待核对的写入。','state_conflict');
    }
    const receipt=await this.workbench.recover(before.plan);
    const ruledOut=before.plan.original && (!before.plan.submission || before.originalNoArtifact);
    const effects=(!receipt&&ruledOut)?await this.workbench.original.sourceEffects(before.plan):null;
    return this.store.change((state,emit)=>{
      const run=runOf(state,id);
      if (!needsWriteCheck(run)) {
        if (run.endedAt) throw new Problem(410,'材料授权已结束。','material_ended');
        return {found:!!run.artifact,...(effects&&!run.reconciled?{checked:true,registered:run.originalRegistered}:{})};
      }
      authorizedMaterials(state,run.conversation,run.materialIds);
      if (receipt) this.accept(state,emit,run,run.plan.result,receipt);
      else if (effects) {
        run.originalRegistered=effects.added.length;
        run.recovery=null;
        retainUnwrittenDraft(run);
        run.error='已核对原项目。本轮登记 '+effects.added.length+' 份材料，分镜尚未保存。';
        emit(run,'workbench_effects_checked',{project:run.plan.project,sourceCount:effects.added.length,task:effects.task});
      } else emit(run,'receipt_unresolved',{project:run.plan.project});
      return {found:!!receipt,...(effects?{checked:true,registered:effects.added.length}:{})};
    });
  }

  abortForMaterials(ids) {
    for (const id of ids) this.jobs.get(id)?.controller.abort(new Error('Material authorization ended'));
  }

  scheduleCleanup() {
    if (this.closing || this.runtimeChanging || this.cleaning || this.jobs.size || Date.now()<this.cleanupRetryAt) return;
    const pending=this.store.read().materials.filter(file=>file.cleanup==='pending');
    if (!pending.length) return;
    this.cleaning=this.cleanMaterials(pending).finally(()=>{this.cleaning=null;});
  }

  async cleanMaterials(files) {
    try {
      this.store.clearOldPages();
    } catch(error) {
      this.cleanupRetryAt=Date.now()+2000;
      console.error('Hyper Bot SQLite cleanup:',error?.code ?? error?.name ?? 'error');
      return;
    }
    for (const file of files) {
      try {
        const state=this.store.read();
        const runs=runsUsing(state,file);
        for (const run of runs) await cleanRuntime(this.config.data,run.id);
        const projects=new Map();
        for (const run of runs.filter(run=>run.kind==='script')) {
          const room=conversationOf(state,run.conversation);
          const project=run.project ?? room.project;
          if (!project || room.original) continue;
          const existing=projects.get(project) ?? [];
          existing.push(run.id);
          projects.set(project,existing);
        }
        for (const [project,ids] of projects) await this.workbench.clearMaterials(project,file.id,ids,file.pendingDigest);
        this.store.change(state=>{
          const row=materialIn(state,file.conversation,file.id);
          row.cleanup='complete';
          delete row.pendingDigest;
          delete row.cleanupIssue;
        });
      } catch(error) {
        this.cleanupRetryAt=Date.now()+2000;
        if (!file.cleanupIssue) this.store.change(state=>{materialIn(state,file.conversation,file.id).cleanupIssue=true;});
        console.error('Hyper Bot material cleanup:',error?.code ?? error?.name ?? 'error');
      }
    }
  }

  expire() {
    const now=Date.now();
    const hasExpired=run=>run.state==='waiting_approval' && run.approval.expiresAt<=now;
    const state=this.store.read();
    const entityEnded=(state,run)=>{
      if (!run.entityRef || !['queued','running','recovering','waiting_approval'].includes(run.state)) return false;
      try {entityContext(state,run,this.config.upstream,now);return false;}
      catch (error) {if (error!==entityUnavailable) throw error;return true;}
    };
    if (state.runs.some(hasExpired) || state.materials.some(file=>expiredMaterial(file,now)) ||
        state.runs.some(run=>entityEnded(state,run))) {
      const abort=this.store.change((state,emit)=>{
        const abort=[];
        for (const file of state.materials.filter(file=>expiredMaterial(file,now))) {
          abort.push(...retireMaterial(this.store,state,emit,file,'expired',at()).abort);
        }
        for (const run of state.runs.filter(run=>entityEnded(state,run))) {
          if (run.approval?.status==='pending') run.approval.status='revoked';
          delete run.plan;
          if (run.generation?.provider) run.usage=run.generation.provider;
          delete run.generation;
          this.store.transition(state,emit,run,'interrupted',{error:entityUnavailable.message});
          abort.push(run.id);
        }
        for (const run of state.runs.filter(hasExpired)) {
          run.approval.status='revoked';
          const retained=retainUnwrittenDraft(run);
          this.store.transition(state,emit,run,'interrupted',{error:retained?'写入审批已过期，分镜尚未写入。':'等待确认已超时，请在原项目重新生成。'});
        }
        return abort;
      });
      this.abortForMaterials(abort);
    }
    this.scheduleCleanup();
    this.recoverDependencies(now,state);
  }

  async shutdown() {
    this.closing=true;
    this.registry.controller?.abort(new Error('Host closing'));
    for (const work of this.jobs.values()) work.controller.abort(new Error('Host closing'));
    await Promise.allSettled([...this.jobs.values()].map(work=>work.done));
    await this.cleaning;
    await this.dependencyCheck?.catch(()=>{});
    await this.workbench.close();
  }
}

