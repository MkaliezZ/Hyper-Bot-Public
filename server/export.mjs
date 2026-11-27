import { strToU8, zipSync } from 'fflate';
import { allArtifacts, artifactOf, at, botOf, conversationOf, withScriptEvidence } from './store.mjs';
import { Problem, id as artifactId, sha } from './contracts.mjs';
import { materialVisibleIn, visibleArtifact } from './materials.mjs';
import { scriptTimingNotes } from './workbench-workflow.mjs';
import { evidenceReviewNotes } from './script-evidence.mjs';

export function quoteLocation(text,quote) {
  if (!text || !quote || !quote.isWellFormed()) return null;
  const first=text.indexOf(quote);
  if (first<0) return null;
  let occurrences=0;
  for (let found=first;found>=0;found=text.indexOf(quote,found+1)) occurrences++;
  const before=text.slice(0,first);
  const startByte=Buffer.byteLength(before);
  return {startByte,endByte:startByte+Buffer.byteLength(quote),
    line:1+(before.match(/\r\n|\r|\n/g)?.length??0),occurrences};
}

function formatVersion(record,room,material,filenameOnly=false) {
  const clean=record.result.title.toWellFormed().replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-');
  const filename=(Array.from(clean).slice(0,80).join('')||'Hyper Bot')+'-v'+record.version+'.md';
  if (filenameOnly) return {filename};
  const millis=seconds=>seconds.toFixed(2).replace(/\.?0+$/,'');
  const citations=[];
  const evidence=(refs,item)=>refs.map(ref=>{
    const file=material(ref.material);
    const location=quoteLocation(file?.content,ref.quote);
    const number=citations.length+1;
    citations.push({number,item,materialId:ref.material,quote:ref.quote,firstMatch:location});
    const line=location?'（第 '+location.line+' 行）':'';
    return '- 引用 '+number+' · '+indexLabel(file?.name??'材料')+line+' ｜ '+ref.quote.replace(/\r\n?|\n/g,'\n  ');
  }).join('\n');
  const items=record.result.segments?.map((row,index)=>[
    '## '+row.name+' ｜ '+millis(row.start)+'–'+millis(row.end)+' 秒','',row.spoken,'',
    '- 画面 '+row.visual,'- 字幕 '+(row.subtitle||'沿用口播'),
    evidence(row.evidence,{kind:'shot',index:index+1,name:row.name,startSeconds:row.start,endSeconds:row.end}),''
  ].filter(Boolean).join('\n'))??record.result.points.map((row,index)=>[
    '## '+row.name,'',row.text,evidence(row.evidence,{kind:'point',index:index+1,name:row.name}),''
  ].join('\n'));
  const notes=[...record.result.notes,...evidenceReviewNotes(record.evidenceReview??[])];
  const markdown=['# '+record.result.title,'','- 版本 v'+record.version,'- 会话 '+room.title+' · '+room.id,
    '- 任务 '+record.run,'- 成果 '+record.id, ...(record.receipt?['- 工作台 '+record.receipt.project,'- 原稿件 '+record.receipt.id]:[]),
    ...(record.kind==='script'?['- 预估时长 '+millis(record.result.segments.at(-1).end)+' 秒']:[]),
    ...(record.timing?scriptTimingNotes(record.timing).map(line=>'- '+line):[]),
    ...(room.simulation?['- 合成演练材料']:[]),'',...items,'',
    ...(notes.length?['## 待确认','',...notes.map(note=>'- '+note),'']:[]),
    '## 授权来源','',...record.materialIds.map(mid=>{const file=material(mid);return '- '+(file?.name??mid)+'  （SHA-256 '+(file?.digest??'已不可用')+'）';}),''].join('\n');
  const manifest={format:'hyper-bot-artifact',schema:1,id:record.id,runId:record.run,conversationId:room.id,
    botId:room.botId,botRevision:room.revision,kind:record.kind,simulation:!!room.simulation,
    version:record.version,previous:record.previous,base:record.base??null,createdAt:record.createdAt,workbench:record.receipt,
    ...(record.proposalBase?{proposalRunId:record.proposalBase}:{}),
    ...(record.timing?{timing:record.timing}:{}),
    ...(record.evidenceReview?{evidenceReview:record.evidenceReview}:{}),
    markdownSha256:sha(markdown),sourceEncoding:'utf-8',citations,
    sources:record.materialIds.map(mid=>{
      const file=material(mid);
      return {id:mid,name:file?.name,digest:file?.digest,
        ...(file?.conversation && file.conversation!==room.id?{originConversationId:file.conversation}:{})};
    })};
  return {filename,markdown,manifest};
}

function materialLookup(state) {
  const materials=new Map(state.materials.map(file=>[file.id,file]));
  return (room,id)=>{
    const file=materials.get(id);
    return materialVisibleIn(file,room) ? file : undefined;
  };
}

export function artifactBundle(store,id,filenameOnly=false) {
  const state=store.read();
  const record=artifactOf(state,id), room=conversationOf(state,record.conversation);
  const lookup=materialLookup(state);
  const material=mid=>lookup(room.id,mid);
  if (!visibleArtifact(record,material)) {
    throw new Problem(410,'此稿件的材料授权已结束。','material_ended');
  }
  return formatVersion(withScriptEvidence(record,state.runs.find(run=>run.id===record.run)),room,material,filenameOnly);
}

export function artifactArchive(store,id) {
  const {filename,markdown,manifest}=artifactBundle(store,id);
  const markdownFile='稿件.md';
  const bytes=zipSync({
    [markdownFile]:strToU8(markdown),
    '版本与来源.json':strToU8(JSON.stringify({...manifest,markdownFile},null,2)+'\n')
  },{level:3});
  artifactBundle(store,id,true);
  return {bytes,filename:filename.replace(/\.md$/,'-成果包.zip')};
}

function versionHistory(state,bot) {
  const belongs=row=>row.botId===bot.id && row.revision===bot.revision;
  const rooms=new Map(state.conversations.filter(belongs).map(room=>[room.id,room]));
  const lookup=materialLookup(state);
  const records=allArtifacts(state).filter(record=>record.botId===bot.id &&
    record.botRevision===bot.revision && rooms.has(record.conversation));
  const visible=record=>visibleArtifact(record,id=>lookup(record.conversation,id));
  const ready=records.filter(visible);
  const filename='Hyper Bot '+bot.id+'-r'+bot.revision+'-历史成果.zip';
  const summary={conversations:rooms.size,exportable:ready.length,unavailable:records.length-ready.length,filename};
  return {ready,rooms,lookup,visible,summary};
}

export function retiredHistorySummary(state,bot) {
  return versionHistory(state,bot).summary;
}

function indexLabel(value) {
  return value.replace(/[\r\n]+/g,' ').replace(/[\\<>\[\]*_`]/g,character=>'\\'+character);
}

export function retiredBotArchive(store,id,revision,summaryOnly) {
  const state=store.read(), bot=botOf(state,id,revision);
  if (bot.status!=='disabled') {
    throw new Problem(409,'请先停用此 Bot 版本，再导出历史成果。','bot_active');
  }
  const {ready,rooms,lookup,visible,summary}=versionHistory(state,bot);
  if (!ready.length) throw new Problem(410,'此版本暂无授权有效的成果可导出。','no_history_export');
  if (summaryOnly) return summary;
  if (ready.length>65532) {
    throw new Problem(413,'该版本的成果过多，可从会话页逐份导出。','history_export_limit');
  }

  const exportedAt=at();
  const entries={};
  const links=[];
  const versions=[];
  const runById=new Map(state.runs.map(run=>[run.id,run]));
  for (const record of ready.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))) {
    const room=rooms.get(record.conversation);
    const file='成果/'+artifactId.parse(record.id)+'.md';
    const {markdown,manifest}=formatVersion(withScriptEvidence(record,runById.get(record.run)),room,id=>lookup(room.id,id));
    entries[file]=strToU8(markdown);
    versions.push({...manifest,file,sha256:manifest.markdownSha256});
    const title=indexLabel(record.result.title);
    links.push('- [v'+record.version+' '+title+']('+file+') · '+indexLabel(room.title)+
      (room.simulation?' · 合成演练':''));
  }
  entries['打开成果.md']=strToU8([
    '# '+indexLabel(bot.name)+' r'+revision+' 的历史成果','',
    '导出时间 '+exportedAt+'。解压后可用文字编辑器打开稿件，也可在 Markdown 阅读器里选读下列版本。',
    '本次导出包含 '+ready.length+' 份成果及引用出处。'+
      (summary.unavailable?'另有 '+summary.unavailable+' 个版本留在 Hyper Bot 的历史记录中。':''),
    '会话和原工作台项目可用「版本与来源.json」内的编号回查。','',...links,''
  ].join('\n'));
  entries['版本与来源.json']=strToU8(JSON.stringify({
    format:'hyper-bot-history',schema:1,exportedAt,bot:{id,name:bot.name,revision},
    counts:{conversations:summary.conversations,exported:summary.exportable,unavailable:summary.unavailable},
    versions
  },null,2)+'\n');
  const bytes=zipSync(entries,{level:3});
  // Authorization may expire while building a large archive.
  if (!ready.every(visible)) {
    throw new Problem(409,'导出期间材料授权已变化。请刷新历史后重试。','history_changed');
  }
  return {bytes,filename:summary.filename,count:summary.exportable};
}

