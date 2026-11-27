import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Clapperboard, ClipboardPaste, FileText, FolderClosed,
  GitBranch, Link2, MoreHorizontal, PanelRight, Paperclip, Pencil, Plus, RotateCw, ShieldCheck, Square, X } from 'lucide-react';
import { api, browseHref, clock, day, dependencyHref, needsReassembly, routeTo, runPhase, seconds } from './client.js';
import { Preview } from './preview.jsx';
import { BotMark } from './components.jsx';
import { ConversationHandoff } from './conversation-handoff.jsx';
import { PasteMaterial } from './paste-material.jsx';
import { MemoryEditor } from './workspace-memory.jsx';
import { EntityPanel } from './entity-archive.jsx';
import { useDetailsMenu } from './details-menu.js';

const live=new Set(['queued','running','recovering','waiting_approval','saving','stopping']);
const recoverLabels={reconciled:'已核对保存回执',required:'写入结果待核对'};

async function saveMaterial(path,body) {
  try {
    return await api(path,{...body,authorized:true},{signal:AbortSignal.timeout(15000)});
  } catch(error) {
    if(error.code) throw error;
    throw new Error('暂未确认材料是否已保存。请用相同名称和原文重试。');
  }
}

function Status({run}) {
  const waiting=run.recovery==='required'||run.stop?.outcome==='unconfirmed'||['waiting_approval','recovering','stopping'].includes(run.state);
  const state=waiting?'wait':run.artifact?'success':run.state;
  const message=run.recovery==='required'?recoverLabels.required:run.reconciled?recoverLabels.reconciled:runPhase(run);
  return <span className={'chip '+state}><i className="phase-dot" aria-hidden="true"/>{message}</span>;
}

function ResultLink({artifact,kind,onClick}) {
  const content=artifact.result;
  return <button className="result-link" onClick={onClick}>
    <span className="result-icon">{kind==='script'?<Clapperboard size={19}/>:<FileText size={18}/>}</span>
    <span><strong>{content?.title ?? '稿件内容已清理'}</strong><small>{kind==='script'?'口播分镜稿':'素材简报'} · v{artifact.version}</small></span>
    <PanelRight className="result-end" size={17}/>
  </button>;
}

function ApprovalCard({run,room,onDecide,onPreview,onReturn,online}) {
  const {review}=run.approval;
  const source=run.proposalBase?'待审稿':review?.sourceVersion?'v'+review.sourceVersion:run.originalBase?'原项目当前稿':'本轮新稿';
  const change=review?.changes?.shots[0];
  const evidenceReview=run.previewEvidenceReview;
  const shot=run.preview?.segments[change?.index??evidenceReview?.[0]?.index??0];
  const tight=run.previewTiming?.shots.filter(row=>!row.fitsSlow).length??0;
  const detail=['spoken','visual','subtitle'].find(field=>change?.fields.includes(field))??'spoken';
  const excerptLabel=change&&({spoken:'口播改动',visual:'画面改动',subtitle:'字幕改动'}[detail]);
  const excerptId='approval-excerpt-'+run.id;
  return <section className="approval-card" aria-label="本轮写入审批" tabIndex={-1}>
    <div className="approval-heading"><ShieldCheck size={18}/><strong>确认保存这版分镜</strong></div>
    <dl>
      <dt>保存到</dt><dd>{room.projectTitle || room.title}{run.approval.original&&' · 独立工作台'}</dd>
      <dt>成果</dt><dd>{run.preview?.title}</dd>
      {review&&<><dt>版次</dt><dd className="approval-version"><span>{source}</span>
        <strong><ArrowRight size={13} aria-hidden="true"/>拟保存 v{review.version}</strong></dd></>}
      {review?.headVersion&&review.headVersion!==review.sourceVersion&&
        <><dt>项目接续</dt><dd>在 v{review.headVersion} 后新增一版</dd></>}
      <dt>授权范围</dt><dd>{run.approval.act}</dd>
      {!!run.approval.sourceNames?.length&&<><dt>同时登记</dt><dd>{run.approval.sourceNames.join('、')}</dd></>}
      <dt>原项目修订</dt><dd>r{run.approval.revision} · {run.id.slice(0,8)}</dd>
      <dt>授权有效至</dt><dd>{clock(run.approval.expiresAt)}</dd>
    </dl>
    {run.approval.original&&<p className="approval-note">已保存到独立工作台的稿件和材料由原项目管理。</p>}
    {tight>0&&<p className="approval-note timing-warning">{tight} 镜的排期短于慢速估算，请在分镜预览中核对。</p>}
    {!!evidenceReview?.length&&<p className="approval-note timing-warning">{evidenceReview.length} 镜有表述待核对原文。</p>}
    {shot&&<button type="button" className="approval-preview" onClick={onPreview}
      aria-label="核对分镜 · 拟写入内容" aria-describedby={excerptId}>
      <span id={excerptId}><small>{seconds(shot.start)}–{seconds(shot.end)} 秒 · {shot.name}
        {change&&' · '+(change.fields.includes(detail)?excerptLabel:'本轮改动')}</small>
        <span className="approval-quote">{shot[detail]||(detail==='subtitle'?'沿用口播':shot.spoken)}</span></span>
      <span className="approval-preview-action"><PanelRight size={15} aria-hidden="true"/>核对分镜</span>
    </button>}
    <div className="approval-actions">
      <button className="button primary" onClick={()=>onDecide(run,true)} disabled={!online}><Check size={16}/>允许本次写入</button>
      <button className="button" onClick={()=>onReturn(run)} disabled={!online}><Pencil size={15}/>先改这版</button>
      <button className="button" onClick={()=>onDecide(run,false)} disabled={!online}>拒绝写入</button>
    </div>
  </section>;
}

function ThreadTurn({run,bot,room,artifact,online,onSource,onArtifact,onPreview,onDecision,onReturn,onStop,onRecover,onRetry,
  onSaveMemory,onMemoryReceipt,onArchive}) {
  const files=run.endedAt?[]:run.materialIds.map(id=>room.materials.find(file=>file.id===id&&!file.endedAt)).filter(Boolean);
  const firstEvidence=(artifact?.result?.segments?.[0] ?? artifact?.result?.points?.[0])?.evidence?.[0];
  const cited=room.materials.find(file=>file.id===firstEvidence?.material);
  const copy=run.endedAt?'材料授权已结束，本轮内容已关闭。':artifact
    ? bot.kind==='script'
      ? (run.reconciled?'已从原项目找回这版分镜稿。'
        : run.proposalBase?'修改后的分镜已保存为 v'+artifact.version+'。'
        : run.base?'改稿已保存为 v'+artifact.version+'。可以在右侧对照上一版。'
        : '已把这版分镜稿存入「'+(room.projectTitle || room.title)+'」。')
      : run.engineRecovered?'已从原任务找回简报。你可以从要点回到引用原文。':'已整理本轮材料。你可以从简报要点回到引用原文。'
    : ({queued:'已接收本轮任务。', running:bot.kind==='script'?'正在按授权材料整理口播、画面和字幕。':'正在整理材料中的共同要点和缺项。',
      recovering:'正在读取这轮任务的本机执行记录。',
      waiting_approval:run.engineRecovered?'已找回本轮分镜。请核对预览，确认是否保存到原项目。':'分镜已经写好。请看预览，确认是否保存到原项目。',
      saving:'正在写入并回读原项目回执。',stopping:'正在等待执行器停止。'})[run.state] || run.error || '本轮已结束。';
  const showOptions=!run.endedAt&&!!run.prompt&&online;
  const optionsMenu=useDetailsMenu(showOptions);
  return <div className="turn">
    <article className="message sent" aria-label="我的消息">
      <div className="byline">我 <time dateTime={run.createdAt}>{clock(run.createdAt)}</time>
        {showOptions&&<details className="message-options" {...optionsMenu}><summary role="button" aria-label="消息操作"><MoreHorizontal size={16}/></summary>
          <div className="workspace-menu"><button className="nav-line" type="button" onClick={event=>{
            const details=event.currentTarget.closest('details');
            details.open=false;
            details.querySelector('summary').focus();
            onSaveMemory({room:room.id,run:run.id,text:run.prompt});
          }}><Link2/>保存为工作区记忆</button></div>
        </details>}
      </div>
      <div className="bubble">{run.prompt}
        {files.length>0&&<div className="chat-files">{files.map(file=><button key={file.id} onClick={()=>onSource(file.id)}><FileText size={14}/>{file.name}</button>)}</div>}
      </div>
    </article>
    <article className="message reply task-anchor" id={'task-'+run.id} tabIndex={-1} aria-label={'任务 '+run.id.slice(0,8)}>
      <BotMark bot={bot}/>
      <div className="reply-content">
        <div className="byline"><strong>{bot.name}</strong><time dateTime={run.updatedAt}>{clock(run.updatedAt)}</time>
          {(!artifact||run.reconciled)&&<Status run={run}/>}</div>
        <p className={'reply-copy'+(live.has(run.state)||run.stop?.outcome?' status-in':'')} key={run.state}>{copy}</p>
        {cited&&<blockquote className="reference"><p>{firstEvidence.quote}</p>
          <button onClick={()=>onSource(cited.id,firstEvidence.quote,bot.kind==='script'?{viewId:artifact.id,index:0}:null)}>
            <FileText size={13}/>{cited.name}</button>
        </blockquote>}
        {artifact&&<ResultLink kind={bot.kind} artifact={artifact} onClick={()=>onArtifact(artifact.id)}/>}
        {onArchive&&artifact?.receipt&&bot.kind==='script'&&run.approval?.status==='accepted'&&<button type="button"
          className="text-button" disabled={!online} onClick={()=>onArchive({kind:'archive',artifact:artifact.id})}>
          <BookOpen size={15}/>存入档案</button>}
        {run.entityReceipt&&<a className="text-button" href={'#entity/'+run.entityReceipt.claim_id}>
          <BookOpen size={15}/>本轮引用档案 v{run.entityReceipt.version}</a>}
        {run.memoryReceipt?.length>0&&<button type="button" className="text-button memory-receipt-link" onClick={()=>onMemoryReceipt(run.id)}>
          <Link2 size={15}/>本轮发送 {run.memoryReceipt.length} 条记忆</button>}
        {run.state==='waiting_approval'&&<ApprovalCard run={run} room={room} online={online}
          onDecide={onDecision} onPreview={onPreview} onReturn={onReturn}/>}
        {['queued','running','recovering','waiting_approval'].includes(run.state)&&<button className="text-button stop" onClick={()=>onStop(run)} disabled={!online}>
          <Square size={14}/>{run.state==='recovering'?'停止核对':'停止任务'}</button>}
        {run.recovery==='required'&&<div className="recovery-actions in-chat">
          <button className="button compact" onClick={()=>onRecover(run)} disabled={!online}><RotateCw size={15}/>只读核对原项目</button>
          <a className="text-button" href={'#recovery/'+run.id}>查看核对详情<ChevronRight size={14}/></a>
        </div>}
        {!run.endedAt && !run.returnedForRevision && !artifact && !live.has(run.state) && !run.recovery&&<button
          type="button" className="text-button stop" disabled={run.unwrittenDraft&&!online}
          onClick={()=>run.unwrittenDraft?onReturn(run):onRetry(run)}>
          <RotateCw size={14}/>{run.unwrittenDraft?'带回待审分镜':'带回本轮草稿'}</button>}
      </div>
    </article>
  </div>;
}

function ConversationMenu({room,bot,workspace,onNew,online}) {
  const menu=useDetailsMenu();
  const rooms=workspace.conversations.filter(item=>item.botId===bot.id);
  const active=workspace.bots.find(item=>item.id===bot.id&&item.status==='enabled');
  function hide() {menu.ref.current.open=false;}
  return <details className="conversation-menu" {...menu}>
    <summary className="icon-button" role="button" aria-label="切换此 Bot 的会话"><ChevronDown size={16}/></summary>
    <div className="workspace-menu">
      {active&&online&&!active.blocked&&<button type="button" className="nav-line" onClick={()=>{hide();onNew(active);}}><Plus/>新建会话</button>}
      {rooms.slice(0,6).map(item=><a className="nav-line" key={item.id} href={'#chat/'+item.id}
        aria-current={item.id===room.id?'page':undefined} onClick={hide}><span>{item.title}</span></a>)}
      <a className="nav-line all-conversations" href={browseHref('history',{bot:bot.id})} onClick={hide}>查看全部会话<ChevronRight size={15}/></a>
    </div>
  </details>;
}

export function Chat({room,bot,workspace,drafts,navButton,refresh,notify,requestedArtifact,requestedMaterial,requestedRun,online,onNew}) {
  const local=useSyncExternalStore(drafts.subscribe,()=>drafts.get(room.id));
  const draft=local?.draft??room.draft;
  const submission=local?.submission;
  const retrying=submission==='retry';
  const addingMaterials=!!local?.addingMaterials;
  const [pasting,setPasting]=useState(false);
  const [memoryBusy,setMemoryBusy]=useState(false);
  const [memorySource,setMemorySource]=useState(null);
  const [memoryRun,setMemoryRun]=useState(null);
  const [entityPanel,setEntityPanel]=useState(null);
  const [entityPick,setEntityPick]=useState(null);
  const entityEnabled=workspace.entityArchive&&!room.original&&!room.simulation;
  const savedEntity=room.selectedEntity?.ref.claim_id===draft.entityRef?.claim_id?room.selectedEntity:null;
  const entitySelection=savedEntity||(entityPick?.ref.claim_id===draft.entityRef?.claim_id?entityPick:null);
  const busy=addingMaterials||!!submission&&!retrying;
  useEffect(()=>()=>{void drafts.flush(room.id);},[drafts,room.id]);
  const [formError,setFormError]=useState('');
  const inputError=formError||local?.materialError;
  const [handoffOpen,setHandoffOpen]=useState(false);
  const [previewOpen,setPreviewOpen]=useState(()=>!!requestedArtifact||!matchMedia('(max-width:760px)').matches);
  const [previewClosing,setPreviewClosing]=useState(false);
  const closeTimer=useRef();
  const [small,setSmall]=useState(()=>matchMedia('(max-width:760px)').matches);
  const [tab,setTab]=useState(bot.kind==='script'?'script':'brief');
  const [chosen,setChosen]=useState(requestedArtifact);
  const [selectedSource,setSelectedSource]=useState(null);
  const [citation,setCitation]=useState(null);
  const requestedSource=room.materials.some(file=>file.id===requestedMaterial)?requestedMaterial:null;
  useEffect(()=>{
    if(!requestedArtifact&&!requestedSource)return;
    if(requestedArtifact)setChosen(requestedArtifact);
    if(requestedSource)setSelectedSource(requestedSource);
    setEntityPanel(null);
    setCitation(null);
    setTab(requestedSource?'materials':bot.kind);
    setPreviewOpen(true);
  },[requestedArtifact,requestedSource,bot.kind]);
  useEffect(()=>()=>clearTimeout(closeTimer.current),[]);
  const [jump,setJump]=useState(false);
  const [earlierAbove,setEarlierAbove]=useState(false);
  const feed=useRef(), composer=useRef(), picker=useRef(), pasteButton=useRef(), toggle=useRef(), origin=useRef(), roomTitle=useRef();
  const closeFocus=useRef(null);
  const pin=useRef(true);
  const focusedTask=useRef(null), stopFocus=useRef(null);
  const firstTab=bot.kind==='script'?'script':'brief';
  const last=room.runs.at(-1);
  const ownLive=last&&live.has(last.state);
  const activeMaterials=room.materials.filter(file=>!file.endedAt);
  const included=activeMaterials.filter(file=>draft.attachments.includes(file.id));
  let materialSummary='查看材料';
  if (activeMaterials.length) {
    materialSummary=included.length===activeMaterials.length
      ? '已授权 '+activeMaterials.length+' 份' : '已选 '+included.length+' 份';
  }
  const handoffTarget=workspace.bots.find(item=>item.id===bot.id && item.revision!==room.revision &&
    item.kind===bot.kind && item.status==='enabled');

  useLayoutEffect(()=>{
    if (room.continuedFrom&&!requestedArtifact&&!requestedMaterial&&!requestedRun) {
      roomTitle.current?.focus({preventScroll:true});
    }
  },[]);

  useEffect(()=>{
    const width=matchMedia('(max-width:760px)');
    const measure=({matches})=>{
      const readingPreview=document.getElementById('right-preview')?.contains(document.activeElement);
      setSmall(matches);
      if(!matches||!readingPreview)setPreviewOpen(!matches);
    };
    width.addEventListener('change',measure);
    return ()=>width.removeEventListener('change',measure);
  },[]);
  useLayoutEffect(()=>{
    if(pin.current) feed.current?.scrollTo({top:feed.current.scrollHeight,behavior:'instant'});
  },[room.runs.length,last?.state,last?.artifact]);
  useLayoutEffect(()=>{
    const input=composer.current;
    if(input){input.style.height='auto';input.style.height=Math.min(120,input.scrollHeight)+'px';}
  },[draft.text]);
  useLayoutEffect(()=>{
    if(previewOpen||!closeFocus.current)return;
    const restoreOpener=closeFocus.current==='opener';
    const target=restoreOpener?origin.current:composer.current;
    closeFocus.current=null;
    origin.current=null;
    target?.focus({preventScroll:true});
    if(restoreOpener&&document.activeElement!==target)toggle.current?.focus({preventScroll:true});
  },[previewOpen]);
  function show(tabName, focus=small, nextCitation=null) {
    setEntityPanel(null);
    clearTimeout(closeTimer.current);setPreviewClosing(false);
    closeFocus.current=null;
    const opener=document.activeElement;
    if((!previewOpen||focus)&&opener!==document.body&&!document.getElementById('right-preview')?.contains(opener)) {
      origin.current=opener;
    }
    setPreviewOpen(true);
    setTab(tabName);
    setCitation(nextCitation);
    if(focus)requestAnimationFrame(()=>{
      const panel=document.getElementById('right-preview');
      panel?.querySelector('[role="tabpanel"]')?.scrollTo({top:0,behavior:'instant'});
      panel?.querySelector('[role="tab"][aria-selected="true"]')?.focus({preventScroll:true});
    });
  }
  function openEntity(mode) {
    show(tab,true);
    setEntityPanel(mode);
  }
  function closePreview(focus=true) {
    if(previewClosing)return;
    if(entityPanel) {
      setEntityPanel(null);
      if(!small) {
        requestAnimationFrame(()=>(focus?origin.current:composer.current)?.focus({preventScroll:true}));
        return;
      }
    }
    clearTimeout(closeTimer.current);
    const finish=()=>{
      closeFocus.current=focus?'opener':'composer';
      setPreviewOpen(false);
      setPreviewClosing(false);
    };
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setPreviewClosing(true);closeTimer.current=setTimeout(finish,120);}
  }
  useEffect(()=>{
    if ((!small&&!entityPanel)||!previewOpen) return;
    const key=event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]'))closePreview();};
    window.addEventListener('keydown',key);
    return ()=>window.removeEventListener('keydown',key);
  },[small,previewOpen,previewClosing,entityPanel]);

  function change(next) {setFormError('');drafts.edit(room,next);}
  function chooseEntity(record) {
    const {claim_id,version}=record.ref;
    setEntityPick(record);
    change(current=>({...current,entityRef:{claim_id,version}}));
    closePreview(false);
  }
  function pick(id,exact,returnTo) {
    setSelectedSource(id);
    show('materials',!!exact||small,exact?{source:id,text:exact,returnTo}:null);
  }
  function openArtifact(id) {setChosen(id);show(firstTab);}
  function openMemory(runId=null) {setMemoryRun(runId);show('memory',true);}
  async function toggleMemory() {
    if(memoryBusy||!online||submission)return;
    setMemoryBusy(true);setFormError('');
    try {
      await api('/rooms/'+room.id+'/memory',{enabled:!room.useWorkspaceMemory});
      await refresh();
    } catch(error) {setFormError(error.message);}
    finally {setMemoryBusy(false);}
  }
  function reviewProposal() {setChosen('proposal');show(firstTab,true);}
  function revise(artifact) {
    const attachments=[...new Set([...artifact.materialIds,...draft.attachments])];
    if (attachments.length>6) {
      notify('本轮最多选 6 份材料。请先在「材料」取消勾选，再继续改稿。');
      return;
    }
    change({text:draft.text,attachments,base:artifact.id});
    if(small)closePreview(false);
    else requestAnimationFrame(()=>composer.current?.focus());
  }
  async function send() {
    if(busy||memoryBusy||block||local?.issue||!draft.text.trim()||ownLive||missingProposalMaterials) return;
    setFormError('');
    try {
      if(await drafts.send(room)) {
        pin.current=true;
        setChosen(null);
      }
    } catch(error) {setFormError(error.message);}
    finally {await refresh();}
  }
  async function resolveDraft(choice) {
    setFormError('');
    await drafts.resolve(room.id,choice);
    await refresh();
  }
  function appendMaterials(ids) {
    change(current=>({...current,attachments:[...new Set([...current.attachments,...ids])].slice(0,6)}));
  }
  async function pasteMaterial(file) {
    await drafts.withMaterialImport(room,async()=>{
      if(drafts.get(room.id).draft.attachments.length>=6) throw new Error('一轮最多添加 6 份材料。');
      const record=await saveMaterial('/rooms/'+room.id+'/materials',file);
      appendMaterials([record.id]);
    });
    void refresh();
  }
  async function upload(files) {
    setFormError('');
    try {
      await drafts.withMaterialImport(room,async()=>{
        const attachments=new Set(drafts.get(room.id).draft.attachments);
        const decoder=new TextDecoder('utf-8',{fatal:true});
        const added=[];
        const failures=[];
        for (const file of files) {
          if (attachments.size>=6) {failures.push('一轮最多添加 6 份材料。');break;}
          try {
            if (!/\.(txt|md)$/i.test(file.name)||file.size>64000) throw new Error('请选择 64 KB 以内的 TXT 或 Markdown。');
            const content=decoder.decode(await file.arrayBuffer());
            const {id}=await saveMaterial('/rooms/'+room.id+'/materials',{name:file.name,content});
            attachments.add(id);
            added.push(id);
          } catch(error) {
            const reason=error instanceof TypeError?'需要 UTF-8 文本。':error.message;
            failures.push(reason+' '+file.name);
          }
        }
        if(added.length)appendMaterials(added);
        return failures.join('\n');
      });
    } catch(error) {setFormError(error.message);}
    void refresh();
  }
  async function action(path,body={},message) {
    try {
      const result=await api(path,body);
      if(typeof message==='function')notify(message(result));
      await refresh();
      return true;
    } catch(error) {notify(error.message);await refresh();return false;}
  }
  const decision=(run,allow)=>action('/runs/'+run.id+'/decide',{
    id:run.approval.id,digest:run.approval.digest,allow});
  async function returnForRevision(run) {
    try {
      const draftToken=await drafts.savedToken(room);
      const ret=await action('/runs/'+run.id+'/revise',{id:run.approval.id,digest:run.approval.digest,draftToken});
      if (!ret) return;
      pin.current=true;
      setChosen('revision');
      setTab(firstTab);
      requestAnimationFrame(()=>composer.current?.focus({preventScroll:true}));
    } catch(error) {notify(error.message);}
  }
  const stop=async run=>{
    stopFocus.current=run.id;
    if (!await action('/runs/'+run.id+'/stop')) stopFocus.current=null;
  };
  const recover=run=>action('/runs/'+run.id+'/recover',{},result=>result.found?'已找回原项目稿件。':
    result.checked?'已核对原项目，分镜尚未保存。':'未读到匹配回执，写入继续暂停。');
  const retry=run=>{
    if(addingMaterials) {notify('请等本轮材料添加完成。');return;}
    const source=run.proposalBase?{base:null,proposalBase:run.proposalBase}:
      {base:run.base??null,...(run.originalBase?{originalBase:run.originalBase}:{})};
    change({text:run.prompt,attachments:run.materialIds,retryOf:run.id,...source});
    composer.current?.focus();
  };
  async function importProjectFile(file) {
    await drafts.withMaterialImport(room,async()=>{
      if(drafts.get(room.id).draft.attachments.length>=6) throw new Error('一轮最多添加 6 份材料。');
      const result=await saveMaterial('/rooms/'+room.id+'/original/materials',{source:file.id,digest:file.digest});
      appendMaterials([result.id]);
      setSelectedSource(result.id);
      setCitation(null);
    });
    await refresh();
  }
  function chooseOriginalDraft(originalBase) {
    const {proposalBase,...fields}=draft;
    change({...fields,base:null,originalBase});
    notify('已带入原项目当前稿。');
  }
  function clearBase() {
    const {originalBase,proposalBase,...fields}=draft;
    change({...fields,base:null,attachments:defaultSource?[]:fields.attachments});
    composer.current?.focus({preventScroll:true});
  }
  const block=!online?'服务恢复后可继续发送。' : bot.skillRevoked?bot.blocked
    : bot.status!=='enabled'?'此 Bot 版本已停用。历史仍可查看，授权有效的成果可导出。'
    :bot.blocked || (workspace.active && workspace.active.conversation!==room.id?'另一个会话正在运行。你仍可编辑草稿。':'');
  const selected=room.artifacts.find(a=>a.id===chosen) ?? room.artifacts.at(-1);
  const proposal=last?.state==='waiting_approval'?last.preview:null;
  const draftProposal=draft.proposalBase&&room.draftProposal?.id===draft.proposalBase?room.draftProposal:null;
  const current=proposal&&(chosen==='proposal'||!chosen)?'proposal':
    draftProposal&&(chosen==='revision'||!chosen)?'revision':selected?.id??null;
  const missingProposalMaterials=draftProposal?.materialIds.some(file=>!draft.attachments.includes(file));
  const base=room.artifacts.find(a=>a.id===draft.base);
  const hasSource=base||draft.originalBase||draft.proposalBase;
  const defaultSource=!!base && !local && base.id===room.suggestedBase;
  const visibleChat=!(small&&previewOpen);
  useLayoutEffect(()=>{
    const run=room.runs.find(item=>item.id===stopFocus.current);
    if (!run?.stop || !['stopping','cancelled','interrupted'].includes(run.state)) return;
    const reply=document.getElementById('task-'+run.id), pane=feed.current;
    const focused=document.activeElement;
    if (!visibleChat || !reply || !pane || (focused!==document.body && !reply.contains(focused))) {
      stopFocus.current=null;
      return;
    }
    const area=pane.getBoundingClientRect(), row=reply.getBoundingClientRect();
    if (row.top<area.top+8 || row.bottom>area.bottom-8) {
      pane.scrollBy({top:row.top-area.top-8,behavior:'instant'});
    }
    reply.focus({preventScroll:true});
    if (run.finishedAt) stopFocus.current=null;
  },[room.runs,visibleChat]);
  const linkedTask=room.runs.some(run=>run.id===requestedRun)?requestedRun:null;
  useLayoutEffect(()=>{
    if(!linkedTask){focusedTask.current=null;return;}
    if(focusedTask.current===linkedTask)return;
    if(!visibleChat){
      if(!requestedArtifact&&!requestedSource)setPreviewOpen(false);
      return;
    }
    const reply=document.getElementById('task-'+linkedTask);
    if(!reply)return;
    const target=reply.querySelector('.approval-card')??reply;
    focusedTask.current=linkedTask;
    pin.current=false;
    target.scrollIntoView({block:'start',behavior:'instant'});
    target.focus({preventScroll:true});
  },[linkedTask,visibleChat,requestedArtifact,requestedSource]);
  function scroll(event) {
    const el=event.currentTarget;
    pin.current=el.scrollHeight-el.scrollTop-el.clientHeight<72;
    setJump(!pin.current);
    setEarlierAbove(el.scrollTop>8);
  }

  return <div className={'conversation'+(previewOpen?' with-preview':'')}>
    <main className="chat" inert={!visibleChat} aria-label={bot.name+' 会话'}>
      <span className="sr" role="status">{last?(last.reconciled?recoverLabels.reconciled:runPhase(last)):''}</span>
      <header className="chat-head">
        {navButton}<BotMark bot={bot} className="large"/>
        <div className="chat-ident"><h1>{bot.name}</h1><p>{workspace.workspace.name}</p></div>
        <ConversationMenu room={room} bot={bot} workspace={workspace} onNew={onNew} online={online}/>
        <button ref={toggle} className="preview-toggle" aria-expanded={previewOpen} aria-controls="right-preview"
          onClick={()=>previewOpen?closePreview():show(tab,true)}><PanelRight size={18}/>预览</button>
      </header>
      <div className="thread-head">
        <div className="thread-heading"><h2 ref={roomTitle} tabIndex={-1}>{room.title}</h2>
          {handoffTarget&&(activeMaterials.length>0||handoffOpen)&&<button type="button" className="text-button handoff-trigger"
            disabled={!online||!!handoffTarget.blocked} onClick={()=>setHandoffOpen(true)}><GitBranch size={16}/>切换版本续接</button>}
        </div>
        <p><FolderClosed size={14}/>{room.projectTitle||room.title}
          <span>·</span>{day(room.createdAt)}{room.original&&<span>· 独立工作台</span>}{room.simulation&&<span className="sample-tag">合成演练</span>}
          {room.continuedFrom&&<a className="thread-source" href={'#chat/'+room.continuedFrom.id}>
            来自 r{room.continuedFrom.revision} 会话 <ChevronRight size={13}/></a>}
        </p>
      </div>
      <div className={'thread-scroll'+(earlierAbove?' earlier-above':'')} id="message-feed" aria-label="消息记录" ref={feed} onScroll={scroll}>
        <div className="thread">
          {room.runs.length===0&&<article className="message reply first-message">
            <BotMark bot={bot}/><div><div className="byline"><strong>{bot.name}</strong></div>
              <p>{room.continuedFrom?'已带入所选材料。告诉我接下来要做什么。':bot.kind==='script'?'把素材和想拍的内容发给我。分镜写好后，可以在右侧读稿并确认保存。':'上传两份或以上授权材料，在这里说明要归纳的主题。'}</p></div>
          </article>}
          {room.runs.map(run=><ThreadTurn key={run.id} run={run} bot={bot} room={room} online={online}
            artifact={room.artifacts.find(a=>a.run===run.id)} onSource={pick} onArtifact={openArtifact}
            onPreview={reviewProposal} onDecision={decision} onReturn={returnForRevision} onStop={stop}
            onRecover={recover} onRetry={retry} onSaveMemory={setMemorySource} onMemoryReceipt={openMemory}
            onArchive={entityEnabled?openEntity:null}/>)}
        </div>
      </div>
      <footer className="compose-wrap">
        {jump&&<button className="jump-button" onClick={()=>{feed.current.scrollTop=feed.current.scrollHeight;pin.current=true;setJump(false);}}><ArrowDown size={14}/>到最新消息</button>}
        <form className="composer" onSubmit={e=>{e.preventDefault();void send();}}>
          {draft.retryOf&&<div className="source-version"><RotateCw size={15}/>重试任务 {draft.retryOf.slice(0,8)}
            <button aria-label="取消重试关联" type="button" onClick={()=>{
              const {retryOf,...fields}=draft;change(fields);
            }}><X size={16}/></button></div>}
          {hasSource&&<div className="source-version source-selection status-in"
            key={base?.id??draft.originalBase??draft.proposalBase}>
            {draft.proposalBase?<button id="draft-source-version" className="text-button" type="button"
              disabled={!draftProposal} onClick={()=>{setChosen('revision');show(firstTab);}}>
              <BookOpen size={15} aria-hidden="true"/>查看待改分镜</button>
              :base?<button id="draft-source-version" className="text-button" type="button"
              title="在预览中打开来源稿件" onClick={()=>openArtifact(base.id)}>
              <BookOpen size={15} aria-hidden="true"/>继续修改 v{base.version}</button>
              :<span className="original-source" id="draft-source-version"><BookOpen size={15} aria-hidden="true"/>续改原项目当前稿</span>}
            <button className="text-button clear-source" aria-label={defaultSource?'另起任务':draft.proposalBase?'移除改稿来源':'清除源版本'}
              type="button" disabled={addingMaterials} onClick={clearBase}><X size={16} aria-hidden="true"/>{defaultSource?'另起任务':null}</button></div>}
          {included.length>0&&<div className="composer-files" role="group" aria-label="本轮选用的材料">{included.map(file=><span key={file.id}>
            <button type="button" title={file.name} onClick={()=>pick(file.id)}>
              <FileText size={14}/><span className="composer-file-name">{file.name}</span>
            </button>
            <button aria-label={'移除 '+file.name} type="button" disabled={addingMaterials}
              onClick={()=>change({...draft,attachments:draft.attachments.filter(x=>x!==file.id)})}><X size={14}/></button>
          </span>)}</div>}
          {draft.entityRef&&<div className="composer-files" role="group" aria-label="本轮档案引用"><span>
            <button type="button" onClick={()=>openEntity({kind:'pick'})}>
              <BookOpen size={14}/><span className="composer-file-name">
                {entitySelection?.title??'档案记录'} · 档案 v{draft.entityRef.version}</span></button>
            <button type="button" aria-label="移除档案引用" disabled={busy||!!submission} onClick={()=>{
              const {entityRef,...fields}=draft;change(fields);
            }}><X size={14}/></button>
          </span>{entitySelection?.reason&&<small className="form-error">{entitySelection.reason}</small>}</div>}
          <label htmlFor="message" className="sr">给{bot.name}发消息</label>
          <textarea id="message" rows={1} ref={composer} maxLength={8000} value={draft.text}
            aria-describedby={hasSource?'draft-source-version':undefined}
            placeholder={hasSource?'说说这一版要怎么改…':'给'+bot.name+'发消息…'}
            disabled={busy||!!submission||bot.status!=='enabled'}
            onChange={e=>change({...draft,text:e.target.value})} onKeyDown={e=>{
              const {isComposing,keyCode}=e.nativeEvent;
              // An IME confirmation can arrive after compositionend with key code 229.
              if(e.key!=='Enter'||e.shiftKey||e.repeat||isComposing||keyCode===229)return;
              e.preventDefault();
              void send();
            }}/>
          <div className="compose-tools">
            <div className="compose-start">
              <input type="file" accept=".txt,.md" hidden multiple ref={picker} disabled={busy||!!submission||bot.status!=='enabled'} onChange={e=>{
                const files=[...e.target.files];e.target.value='';if(files.length)void upload(files);
              }}/>
              <button type="button" className="text-button" title="添加本轮授权文字" disabled={busy||!!submission||bot.status!=='enabled'}
                onClick={()=>picker.current.click()}><Paperclip size={17}/>材料</button>
              <button ref={pasteButton} type="button" className="text-button" title="将一段原文添加为会话材料"
                disabled={!online||busy||!!submission||bot.status!=='enabled'} onClick={()=>{
                  if(draft.attachments.length>=6) setFormError('一轮最多添加 6 份材料。');
                  else {setFormError('');setPasting(true);}
                }}><ClipboardPaste size={16}/>粘贴文字</button>
              {(room.materials.length>0||room.original)&&<button type="button" className="text-button materials-action"
                onClick={()=>show('materials')}>{materialSummary}<ChevronRight size={13}/></button>}
              {entityEnabled&&<button type="button" className="text-button"
                disabled={!online||busy||!!submission||bot.status!=='enabled'} onClick={()=>openEntity({kind:'pick'})}>
                <BookOpen size={16}/>引用档案</button>}
            </div>
            <div className="compose-end"><kbd>Enter</kbd>
              <button type="submit" className="send" disabled={busy||memoryBusy||!!submission||ownLive||!!block||!!local?.issue||
                !!missingProposalMaterials||!draft.text.trim()}
                aria-label="发送消息"><ArrowUp size={19}/></button>
            </div>
          </div>
          <div className="memory-composer">
            <button className="text-button memory-toggle" type="button" aria-label="使用工作区记忆"
              aria-pressed={room.useWorkspaceMemory===true} disabled={memoryBusy||!online||!!submission||bot.status!=='enabled'} onClick={()=>void toggleMemory()}>
              <Link2 size={15}/>{room.useWorkspaceMemory?'使用工作区记忆':'仅用本会话'}</button>
            {room.useWorkspaceMemory&&<button className="text-button" type="button" onClick={()=>openMemory()}>查看记忆<ChevronRight size={13}/></button>}
          </div>
        </form>
        {missingProposalMaterials&&<p className="compose-note" role="status">请在「材料」选回待审稿使用的全部材料。</p>}
        {addingMaterials?<p className="compose-note" role="status">正在添加材料…</p>
        :local?.issue==='conflict'?<div key="draft-conflict" className="compose-note draft-status" role="status">
          <span>此会话有新的已保存草稿。</span>
          <button type="button" className="text-button" onClick={()=>resolveDraft('adopt')} disabled={!online}>采用已保存稿</button>
          <button type="button" className="text-button" onClick={()=>resolveDraft('replace')} disabled={!online}>保存当前稿</button>
        </div>:local?.issue?<div key="draft-retry" className="compose-note draft-status" role="status">
          <span>{local.error||'草稿暂存于当前窗口。'}</span>
          {online&&<button type="button" className="text-button" onClick={()=>resolveDraft('retry')}>重试保存</button>}
        </div>:submission==='checking'||submission==='accepted'?<div key="send-check" className="compose-note draft-status" role="status">
          <span>{submission==='accepted'?'已受理，正在读取任务。':'正在核对发送回执。'}</span>
          <button type="button" className="text-button" onClick={async()=>{await drafts.check(room.id);await refresh();}} disabled={!online}>查询回执</button>
        </div>:retrying?<div key="send-retry" className="compose-note draft-status" role="status">
          <span>尚未查到受理回执。重试会使用同一请求编号。</span>
          <button type="button" className="text-button" onClick={send} disabled={!!block||ownLive}>重试同一条消息</button>
        </div>
          :(inputError||block)&&<p className={inputError?'form-error':'compose-note'} role={inputError?'alert':undefined}
            tabIndex={inputError?0:undefined}>
            {inputError||block}{online&&bot.blocked&&(bot.status==='enabled'||bot.skillRevoked)&&<> <a className="dependency-link" href={dependencyHref(bot,room.id)}>{needsReassembly(bot)?'查看 Bot 版本':'检查依赖'}</a></>}
          </p>}
      </footer>
      {pasting&&<PasteMaterial materials={room.materials} online={online} onAdd={pasteMaterial}
        onClose={()=>{setPasting(false);pasteButton.current?.focus({preventScroll:true});}}/>}
      {memorySource&&<MemoryEditor workspace={workspace} source={memorySource} onClose={()=>setMemorySource(null)}
        onSaved={()=>{setMemorySource(null);notify('已保存工作区记忆。');}}/>}
      {handoffOpen&&handoffTarget&&<ConversationHandoff room={room} target={handoffTarget} online={online&&!handoffTarget.blocked}
        onClose={()=>setHandoffOpen(false)} onCreated={id=>{
          setHandoffOpen(false);
          routeTo('chat/'+id);
          void refresh();
        }}/>}
    </main>
    {previewOpen&&<Preview room={room} kind={bot.kind} tab={tab} artifact={selected}
      entity={entityPanel&&<EntityPanel mode={entityPanel} version={workspace.version} online={online}
        onChoose={chooseEntity} onClose={closePreview} onSaved={()=>{closePreview();notify('已存入档案。');void refresh();}}/>}
      setTab={next=>{setCitation(null);if(next!=='memory')setMemoryRun(null);setTab(next);}}
      memoryRun={memoryRun} chosen={current} pending={proposal} draftProposal={draftProposal} setChosen={setChosen}
      sourceId={selectedSource} setSourceId={id=>{setSelectedSource(id);setCitation(null);}}
      citation={citation} openSource={pick} onClose={closePreview}
      onRevise={revise} onImportProject={importProjectFile} onOriginalDraft={chooseOriginalDraft} onSelectFiles={ids=>change({...draft,attachments:ids})} attachments={draft.attachments}
      addingMaterials={addingMaterials} canRevise={bot.status==='enabled'&&!ownLive&&!busy&&!submission} notify={notify} small={small} closing={previewClosing}
      materialRetention={workspace.materialRetention} online={online} refresh={refresh}/>}
  </div>;
}

