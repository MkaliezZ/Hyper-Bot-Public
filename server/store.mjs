import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ALLOWED, Problem, sha } from './contracts.mjs';
import { DSH_VERSION, HERMES_REVISION, root } from './config.mjs';
import { relatedProjectVersions } from './history.mjs';
import { activeMaterial, hidesArtifact, materialMetadata, materialVisibleIn, visibleArtifact } from './materials.mjs';
import { currentMemory } from './workspace-memory.mjs';

export const at = () => new Date().toISOString();
export const isLive = run => Object.hasOwn(ALLOWED, run.state);
const get = (records,id,message) => {
  const item = records.find(row=>row.id === id);
  if (!item) throw new Problem(404,message,'not_found');
  return item;
};
export const conversationOf = (state,id) => get(state.conversations,id,'会话不存在。');
export const runOf = (state,id) => get(state.runs,id,'任务不存在。');
export const allArtifacts = state => [...state.artifacts, ...(state.retiredArtifacts ?? [])];
export const artifactOf = (state,id) => get(allArtifacts(state),id,'稿件版本不存在。');
export const skillOf = (state,id) => get(state.skills,id,'Skill 版本不存在。');
export const botOf = (state,id,revision) => {
  const item = state.bots.find(bot=>bot.id === id && bot.revision === revision);
  if (!item) throw new Problem(404,'Bot 版本不存在。');
  return item;
};

async function initial() {
  const authors = { 'talking-script':'Self Media Workbench 口播规则', 'material-brief':'Hyper Bot 素材简报规则' };
  const skills = await Promise.all(Object.keys(authors).map(async id => {
    const content = await readFile(path.join(root,'skills',id+'.md'),'utf8');
    return {id, name:id==='talking-script'?'口播分镜':'素材简报', version:'1.0.0',content,
      digest:sha(content), origin:authors[id], importedAt:at(),builtin:true};
  }));
  const bots = [
    {id:'media',revision:1,kind:'script',driver:'dsh-web',driverRevision:DSH_VERSION,name:'自媒体口播',subtitle:'Self Media Workbench',
      description:'根据已有选题和文字素材，写有时间码、画面建议和字幕的口播分镜。可以在同一项目续改。',
      input:'授权的 TXT / Markdown，连同受众、方向和预估时长',output:'可预览、改版和导出的 Markdown 分镜稿',
      skills:['talking-script'], status:'enabled', createdAt:at(),qualification:'pinned-dev'},
    {id:'brief',revision:1,kind:'brief',driver:'hermes',driverRevision:HERMES_REVISION,name:'素材简报',subtitle:'文字材料',
      description:'归纳证据、分歧与未确认的问题，从要点回到所引用的原文。',
      input:'2–6 份授权的 TXT / Markdown',output:'带逐字引用的 Markdown 简报',skills:['material-brief'],
      status:'enabled',createdAt:at(),qualification:'pinned-dev'}
  ];
  return { version:0, skills, bots, conversations:[], materials:[], runs:[],artifacts:[],
    registered:{dsh:DSH_VERSION,'dsh-web':DSH_VERSION,hermes:HERMES_REVISION} };
}

export class Store {
  events;
  changeListeners = new Set();
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.function('hyper_bot_linked_materials',()=>1);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA secure_delete=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace (key INTEGER PRIMARY KEY CHECK(key=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        run TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (run,seq)
      );
    `);
    this.getState = this.db.prepare('SELECT body FROM workspace WHERE key=1');
    this.saveState = this.db.prepare('INSERT INTO workspace(key,body) VALUES(1,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
    this.addEvent = this.db.prepare('INSERT INTO events(run,seq,kind,created,data) VALUES(?,?,?,?,?)');
    this.events = this.db.prepare('SELECT seq, kind, created, data FROM events WHERE run=? AND seq>? ORDER BY seq LIMIT 512');
    this.writeChecks = this.db.prepare(`
      SELECT run,kind,MAX(created) AS checkedAt FROM events
      WHERE kind IN ('receipt_unresolved','workbench_effects_checked') GROUP BY run,kind
    `);
  }

  async init() {
    if (!this.getState.get()) this.saveState.run(JSON.stringify(await initial()));
  }

  read() { return JSON.parse(this.getState.get().body); }

  change(apply) {
    this.db.exec('BEGIN IMMEDIATE');
    let result, version;
    try {
      const state = this.read();
      const emit = (run,kind,data={}) => {
        run.seq=(run.seq ?? 0)+1;
        this.addEvent.run(run.id,run.seq,kind,at(),JSON.stringify({
          runId:run.id, conversationId:run.conversation,botId:run.botId,botRevision:run.botRevision,role:'system',...data
        }));
      };
      result = apply(state,emit);
      version = ++state.version;
      this.saveState.run(JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const listener of this.changeListeners) listener(version);
    return result;
  }

  requireLinkedMaterialSupport() {
    // A legacy writer cannot enforce shared expiry and revocation. Install
    // the guard in the same transaction as the first linked grant.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS require_linked_materials
      BEFORE UPDATE OF body ON workspace WHEN hyper_bot_linked_materials() <> 1
      BEGIN SELECT RAISE(ABORT,'Unsupported linked material scope'); END;
    `);
  }

  onChange(fn) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  transition(state, emit, run, phase, patch = {}) {
    if (!ALLOWED[run.state]?.has(phase)) throw new Problem(409,'该任务状态已变化。','state_conflict');
    Object.assign(run,patch,{state:phase,updatedAt:at()});
    if (!isLive(run)) run.finishedAt=run.updatedAt;
    emit(run,'state',{state:phase, reason:run.error ?? null,
      elapsedMs:Date.parse(run.updatedAt)-Date.parse(run.createdAt), usage:run.usage ?? null});
  }

  clearOldPages() {
    this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() { this.db.close(); }
}

export function publicRun(run) {
  const { plan, approval, materialIds, generation, accounting, followUpDraftStamp, memoryRefs, ...info } = run;
  const preview = run.state === 'waiting_approval' ? plan?.result : undefined;
  return {...info,materialIds,preview,
    ...(preview&&plan?.timing?{previewTiming:plan.timing}:{}),
    ...(preview&&plan?.evidenceReview?{previewEvidenceReview:plan.evidenceReview}:{}),
    approval: approval ? {id:approval.id,expiresAt:approval.expiresAt,digest:approval.digest,
      status:approval.status, project:plan?.project, revision:plan?.body?.revision,
      supersedes:plan?.body?.supersedes ?? null, act:'在原项目新增口播分镜版本',
      ...(preview&&approval.review?{review:approval.review}:{}),
      ...(plan?.original?{original:true,sourceNames:plan.register.map(item=>item.name)}:{})} : null};
}

export function draftToken(room) {
  return sha(JSON.stringify([room.draftStamp??null,room.draft??null,room.draftRetry??null,
    ...(room.draftProposal?[room.draftProposal]:[])]));
}

export function setRoomDraft(room,value) {
  const {retryOf,proposalBase,...draft}=value;
  room.draft=draft;
  room.draftStamp=randomUUID();
  // Older builds can edit this draft using the original fields.
  if (retryOf) room.draftRetry={id:retryOf,digest:sha(JSON.stringify(draft))};
  else delete room.draftRetry;
  if (proposalBase) room.draftProposal={id:proposalBase,stamp:room.draftStamp};
  else delete room.draftProposal;
}

export function revisableProposalIn(room,run) {
  const returned=run?.returnedForRevision===true && run.state==='cancelled';
  const unwritten=run?.unwrittenDraft===true && ['failed','interrupted'].includes(run.state) && !run.recovery && !run.artifact;
  return (returned||unwritten) && run.kind==='script' &&
    run.conversation===room.id && run.botId===room.botId && run.botRevision===room.revision &&
    (run.plan?.project??run.project)===room.project;
}

export function withScriptEvidence(record,run) {
  // Older builds already remove the plan when material authorization ends.
  const evidenceReview=run?.endedAt?undefined:run?.plan?.evidenceReview;
  return evidenceReview?{...record,evidenceReview}:record;
}

export function roomView(state,id) {
  const room = conversationOf(state,id);
  const { draft, draftRetry, draftProposal, draftStamp, handoffRequest, ...info } = room;
  const current=draft??{text:'',attachments:[],base:null};
  const retry=draftRetry?.digest===sha(JSON.stringify(current))?draftRetry.id:null;
  const records=allArtifacts(state);
  const files=state.materials.filter(row=>materialVisibleIn(row,id));
  const material=fileId=>files.find(file=>file.id===fileId);
  const runs=state.runs.filter(row=>row.conversation===id);
  const runById=new Map(runs.map(run=>[run.id,run]));
  const proposal=draftProposal?.stamp===draftStamp
    ? runs.find(run=>run.id===draftProposal?.id && revisableProposalIn(room,run) && !run.endedAt && run.plan?.result &&
      run.approval?.status==='revoked' && currentMemory(state,run) && run.plan.original?.storage===room.original?.storage &&
      run.materialIds.every(fileId=>activeMaterial(material(fileId))))
    : null;
  const artifacts=records.filter(row=>row.conversation===id).sort((a,b)=>a.version-b.version)
    .map(record=>visibleArtifact(record,material)?withScriptEvidence(record,runById.get(record.run)):
      hidesArtifact(record,record.endedAt??at()));
  const last=runs.at(-1);
  // Offer a source without writing over any draft started during the task.
  const untouched=draftStamp && last?.followUpDraftStamp===draftStamp && !retry && !proposal &&
    current.text==='' && current.attachments.length===0 && !current.base && !current.originalBase;
  const enabled=untouched && state.bots.some(bot=>bot.id===room.botId && bot.revision===room.revision && bot.status==='enabled');
  const source=enabled ? artifacts.find(record=>record.id===last.artifact &&
    record.project===room.project && !record.endedAt) : null;
  const saved={...current,...(retry?{retryOf:retry}:{}),...(proposal?{proposalBase:proposal.id}:{})};
  const next=source ? {...saved,attachments:source.materialIds,base:source.id} : saved;
  return { ...info,draft:next,...(source?{suggestedBase:source.id}:{}),
    ...(proposal?{draftProposal:{id:proposal.id,result:proposal.plan.result,timing:proposal.plan.timing,
      evidenceReview:proposal.plan.evidenceReview,
      materialIds:proposal.materialIds}}:{}),
    draftToken:draftToken(room),snapshotVersion:state.version,
    runs:runs.map(publicRun),materials:files.map(materialMetadata),artifacts,
    projectVersions:relatedProjectVersions(state,records,room) };
}

export function makeConversation(bot,title, tuning={}) {
  return { id:randomUUID(), botId:bot.id, revision:bot.revision, title,createdAt:at(),updatedAt:at(),
    simulation:!!tuning.simulation, project:tuning.project ?? null, projectTitle:tuning.title ?? null,
    projectRequired:!!tuning.project,draft:{text:'',attachments:[],base:null},
    ...(tuning.original?{original:tuning.original}:{}) };
}

