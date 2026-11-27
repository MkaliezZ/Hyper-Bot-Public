import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { OriginalProject } from './original-project.jsx';
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Download, FileText,
  FolderClosed, Layers, PanelRight, Pencil, ShieldCheck, X } from 'lucide-react';
import { api, apiPath, artifactHref, clock, day, downloadFile, seconds } from './client.js';
import { MaterialAuthorization } from './material-authorization.jsx';
import { MemoryReceipt } from './workspace-memory.jsx';
import { claimLabels, fieldLabels } from '../server/script-evidence.mjs';

function Cover({result,kind,simulation,timing}) {
  const script=kind==='script';
  return <div className={'cover'+(simulation?' bookshop':'')}>
    {simulation&&<img alt="街角书店合成演练的书架封面" src="/media/bookshop.webp"/>}
    <h3>{result.title}</h3>
    <p>{script?<Clock size={15}/>:<FileText size={15}/>}
      {script?<>{timing?'排期':'约'} {seconds(result.segments.at(-1).end).replace(/^0(?=\d)/,'')} 秒 <i>/</i> {result.segments.length} 镜 <i>/</i> 口播分镜稿</>
        :<>{result.points.length} 个要点 <i>/</i> 素材简报</>}</p>
  </div>;
}

function focusPreviewItem(item) {
  const pane=item?.closest('.preview-content');
  const position=item?.getClientRects()[0];
  if(!pane||!position)return;
  const bounds=pane.getBoundingClientRect();
  if(position.top<bounds.top+12||position.bottom>bounds.bottom-12) {
    const inset=Math.min(88,pane.clientHeight/5);
    pane.scrollTo({top:pane.scrollTop+position.top-bounds.top-inset,behavior:'instant'});
  }
  item.focus({preventScroll:true});
}

function Evidence({refs,room,openSource}) {
  if (!refs?.length) return null;
  return <div className="evidence">
    {refs.map((ref,index)=>{
      const name=room.materials.find(file=>file.id===ref.material)?.name;
      const key=ref.material+'-'+index;
      return openSource?<button key={key} onClick={()=>openSource(ref.material,ref.quote)}>
        <FileText size={13}/>{name??'查看引用'}</button>
        :<blockquote className="reference sample-quote" key={key}><p>{ref.quote}</p>{name&&<cite>{name}</cite>}</blockquote>;
    })}
  </div>;
}

function Script({room,result,caption,openSource,review,timing,evidenceReview,returnShot,clearReturnShot}) {
  const changes=review?.changes;
  const [shot,setShot]=useState(returnShot?.index??evidenceReview?.[0]?.index??changes?.shots[0]?.index??0);
  const returnToggle=useRef(null);
  useEffect(()=>{
    if(!returnShot)return;
    const frame=requestAnimationFrame(()=>{
      focusPreviewItem(returnToggle.current);
      clearReturnShot(null);
    });
    return ()=>cancelAnimationFrame(frame);
  },[returnShot,clearReturnShot]);
  const summary=changes&&[
    changes.shots.length?'改动 '+changes.shots.length+' 镜':null,
    changes.removed?'减少 '+changes.removed+' 镜':null,
    changes.title?'调整稿名':null,
    changes.notes?'更新待确认事项':null
  ].filter(Boolean).join(' · ');
  const tight=timing?.shots.filter(row=>!row.fitsSlow).length??0;
  return <>
    <Cover result={result} kind="script" simulation={room.simulation} timing={timing}/>
    {timing&&<section className="script-timing" aria-label="口播时长核对">
      <div><strong>口播估算 {timing.fastSeconds}–{timing.slowSeconds} 秒</strong>
        {tight>0&&<span className="timing-warning">{tight} 镜需核对</span>}</div>
      <p>按 {timing.rates.join('–')} 字/分钟。数字、英文和停顿以真人试读为准。</p>
    </section>}
    <div className="panel-subhead"><h4>分镜时间轴</h4><span className="version">{caption}</span></div>
    {summary&&<p className="proposal-changes">{summary}</p>}
    <div className="time-strip" aria-hidden="true">{result.segments.map((item,index)=><span key={index}
      style={{flex:item.end-item.start}} className={index===shot?'selected':''}/>)}</div>
    {result.segments.map((row,index)=>{
      const statements=evidenceReview?.find(item=>item.index===index)?.statements;
      return <section className={'shot'+(index===shot?' open':'')} key={index}>
        <button className="shot-toggle" ref={returnShot?.index===index?returnToggle:undefined}
          aria-expanded={shot===index} aria-controls={shot===index?'shot-body-'+index:undefined} onClick={()=>setShot(shot===index?-1:index)}>
          <span className="timecode">{seconds(row.start)}–{seconds(row.end)} 秒</span>
          <span className="shot-heading"><strong>{row.name}</strong>
            {changes?.shots.some(change=>change.index===index)&&<small className="shot-change">改动</small>}
            {timing?.shots[index]?.fitsSlow===false&&<small className="shot-change">时长待核对</small>}
            {statements&&<small className="shot-change">依据待核对</small>}
          </span>
          <ChevronDown size={16}/>
        </button>
        {index===shot&&<div className="shot-detail" id={'shot-body-'+index}>
          {timing?.shots[index]&&<p className={'shot-timing'+(timing.shots[index].fitsSlow?'':' timing-warning')}>
            口播估算 {timing.shots[index].fastSeconds}–{timing.shots[index].slowSeconds} 秒 · {timing.shots[index].characters} 字
          </p>}
          <p>{row.spoken}</p>
          <dl><dt>画面</dt><dd>{row.visual}</dd><dt>字幕</dt><dd>{row.subtitle||'沿用口播'}</dd></dl>
          {statements&&<section className="shot-evidence-review">
            <h5>需要核对的表述</h5>
            <ul>{statements.map(({text,fields,kinds})=><li key={text}>
              <span>{fields.map(field=>fieldLabels[field]).join('和')} · {kinds.map(kind=>claimLabels[kind]).join('、')}</span>
              <p>{text}</p>
            </li>)}</ul>
            {!row.evidence.length&&<p className="muted">本镜尚未附原文。</p>}
          </section>}
          <Evidence refs={row.evidence} room={room} openSource={openSource?(id,quote)=>openSource(id,quote,index):undefined}/>
        </div>}
      </section>;
    })}
    <Notes notes={result.notes}/>
  </>;
}

function Notes({notes}) {
  return notes.length>0&&<section className="notes"><h4>待确认</h4><ul>{notes.map((note,index)=><li key={index}>{note}</li>)}</ul></section>;
}

function Brief({room,result,openSource}) {
  return <><Cover result={result} kind="brief" simulation={room.simulation}/>
    <div className="brief-points">{result.points.map((point,index)=><section key={index}><h4>{point.name}</h4><p>{point.text}</p>
      <Evidence refs={point.evidence} room={room} openSource={openSource}/></section>)}</div>
    <Notes notes={result.notes}/>
  </>;
}

export function SampleOutput({kind,result,materials,timing,evidenceReview,caption='验证样例'}) {
  const room={materials};
  return kind==='script'?<Script room={room} result={result} timing={timing} evidenceReview={evidenceReview} caption={caption}/>:<Brief room={room} result={result}/>;
}

function MaterialContent({room,sourceId,citation}) {
  const [source,setSource]=useState(null);
  const [error,setError]=useState('');
  const mark=useRef(null);
  const quote=citation?.source===sourceId?citation?.text:'';
  const start=quote&&source?.id===sourceId?source.content.indexOf(quote):-1;
  useEffect(()=>{
    if(start<0)return;
    const frame=requestAnimationFrame(()=>focusPreviewItem(mark.current));
    return ()=>cancelAnimationFrame(frame);
  },[citation,start]);
  useEffect(()=>{
    if (!sourceId) {setSource(null);return;}
    const controller=new AbortController();
    setError('');
    api('/rooms/'+room.id+'/materials/'+sourceId,undefined,{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setSource(value);})
      .catch(error=>{if (error.name!=='AbortError')setError(error.message);});
    return ()=>controller.abort();
  },[room.id,sourceId]);
  if(error)return <p className="form-error" role="alert">{error}</p>;
  if(!sourceId)return null;
  if(source?.id!==sourceId)return <p className="muted" role="status">正在读取原文…</p>;
  return <section className="source-preview"><div className="panel-subhead"><h4>原文预览</h4><span>{source.name.toLowerCase().endsWith('.txt')?'TXT':'Markdown'}</span></div>
    <div className="source-paper"><h4>{source.name}</h4><div className="source-text">
      {start<0 ? source.content : <>{source.content.slice(0,start)}<mark ref={mark} tabIndex={-1}>{quote}</mark>{source.content.slice(start+quote.length)}</>}
    </div></div>
  </section>;
}

const materialState=file=>file.reason==='expired'?'授权已到期':'授权已撤回';

function Materials({room,sourceId,setSourceId,citation,attachments,onSelectFiles,online,onSaved,materialRetention,onImportProject,onOriginalDraft,canRevise,addingMaterials}) {
  const [editGrant,setEditGrant]=useState(null);
  const [projectOpen,setProjectOpen]=useState(false);
  const selected=room.materials.find(file=>file.id===sourceId);
  const grant=room.materials.find(file=>file.id===editGrant && !file.endedAt);
  if (!room.materials.length&&!room.original) return <p className="panel-empty">在聊天输入框点「材料」添加授权文字。</p>;
  return <><div className="panel-title-row"><h3>会话材料</h3>
    <div className="panel-actions">
      {room.original&&<button type="button" className="text-button" disabled={!online||!canRevise} onClick={()=>setProjectOpen(true)}>
        <BookOpen size={15}/>从原项目选用</button>}
      {materialRetention&&selected&&!selected.endedAt&&<button type="button" className="text-button" disabled={!online} onClick={()=>setEditGrant(selected.id)}>
        <ShieldCheck size={15}/>管理授权</button>}
    </div></div>
    {!room.materials.length&&<p className="muted">可选用原项目里的文字，或从聊天输入框添加文件。</p>}
    <div className="side-list">{room.materials.map(file=><div key={file.id} className={'side-row'+(sourceId===file.id?' selected':'')}>
      <button onClick={()=>setSourceId(file.id)} aria-pressed={sourceId===file.id}>
        <span className="file-icon"><FileText size={17}/></span><span>
          <strong>{file.endedAt?materialState(file):file.name}</strong>
          <small>{file.endedAt?(file.cleanupIssue?'等待重试清理':file.cleanup==='pending'?'正在清理本机副本':'本机副本已清理')
            :file.expiresAt?'有效至 '+new Date(file.expiresAt).toLocaleString('zh-CN',{hour12:false})
            :file.originalSource?'原工作台文字':file.nature==='simulation'?'合成材料':'已授权文本'}</small></span>
      </button>
      {!file.endedAt&&<input type="checkbox" aria-label={'本轮选用 '+file.name} checked={attachments.includes(file.id)} disabled={addingMaterials} onChange={e=>{
        if(e.target.checked && attachments.length>=6)return;
        onSelectFiles(e.target.checked?[...attachments,file.id]:attachments.filter(id=>id!==file.id));
      }}/>}
    </div>)}</div>
    {selected?.endedAt ? <section className="source-preview source-paper" aria-label="材料状态">
      <h4>{materialState(selected)}</h4>
      <p className="muted">{selected.cleanupIssue?'原文访问已关闭。暂有副本待清理，系统会重试。'
        :selected.cleanup==='pending'?'原文访问已关闭。本机副本正在清理。':'原文和关联内容已从本机工作区清理。'}</p>
    </section> : <MaterialContent room={room} sourceId={sourceId} citation={citation}/>}
    {grant&&<MaterialAuthorization key={grant.id} file={grant} roomId={room.id} original={!!room.original}
      onClose={()=>setEditGrant(null)} onSaved={onSaved}/>}
    {projectOpen&&<OriginalProject room={room} attachments={attachments} onAttach={onImportProject}
      onBase={onOriginalDraft} onClose={()=>setProjectOpen(false)}/>}
  </>;
}

const sameRow=(row,other,kind)=>kind==='script'
  ? other && row.spoken===other.spoken && row.visual===other.visual && row.subtitle===other.subtitle &&
    row.start===other.start && row.end===other.end && row.name===other.name
  : other && row.text===other.text && row.name===other.name;
function Versions({room,chosen,setChosen,kind}) {
  const related=room.projectVersions??[];
  const items=[...room.artifacts,...related].sort((a,b)=>b.version-a.version||b.createdAt.localeCompare(a.createdAt));
  if(!items.length)return <p className="panel-empty">确认保存或生成成果后，可在这里查看版本。</p>;
  const artifact=room.artifacts.find(item=>item.id===chosen) ?? room.artifacts.at(-1);
  const previous=room.artifacts.find(item=>item.id===artifact?.previous);
  const remotePrevious=related.find(item=>item.id===artifact?.previous);
  const rows=artifact?.result?.segments ?? artifact?.result?.points ?? [];
  const before=previous?.result?.segments ?? previous?.result?.points ?? [];
  const comparable=!!(previous?.result && artifact?.result);
  const changes=comparable ? rows.flatMap((row,index)=>sameRow(row,before[index],kind)?[]:[{row,old:before[index]}]) : [];
  return <><h3 className="panel-title">稿件版本</h3>
    <div className="side-list">{items.map(item=>{
      const otherRoom=item.conversation!==room.id;
      const selected=item.id===artifact?.id;
      const title=(otherRoom?item.title:item.result?.title)??'稿件内容已清理';
      const summary=<><span className="version-id">v{item.version}</span><span><strong>{title}</strong>
        <small>{otherRoom?item.roomTitle+' · ':''}{day(item.createdAt)} {clock(item.createdAt)} · 任务 {item.run.slice(0,8)}</small></span>
        {selected?<Check size={15}/>:<ChevronRight size={15}/>}</>;
      return <div key={item.id} className={'side-row'+(selected?' selected':'')}>
        {otherRoom?<a href={artifactHref(item)} aria-label={'打开 v'+item.version+' · '+item.roomTitle}>{summary}</a>
          :<button onClick={()=>setChosen(item.id)} aria-pressed={selected}>{summary}</button>}
      </div>;
    })}</div>
    {remotePrevious&&<div className="compare"><a className="text-button" href={artifactHref(remotePrevious)}><BookOpen size={15}/>
      打开前一版 v{remotePrevious.version}</a></div>}
    {comparable&&<section className="compare"><div className="panel-subhead"><h4>与 v{previous.version} 的改动</h4></div>
      {!changes.length&&before.length===rows.length ? <p className="muted">可见正文一致。</p> : changes.map(({row,old},index)=>
        <div className="compare-row" key={index}><h4>{row.name}</h4>
          {old&&<p><span>v{previous.version}</span>{old.spoken??old.text}</p>}
          <p className="revised"><span>v{artifact.version}</span>{row.spoken??row.text}</p>
        </div>)}
      {before.length>rows.length&&<p className="muted">此版本较上一版少 {before.length-rows.length} 项。</p>}
    </section>}
  </>;
}

function ExportOptions({artifact,onClose,onSelect}) {
  const modal=useRef(), first=useRef(), timer=useRef();
  const heading=useId();
  const [leaving,setLeaving]=useState(false);
  useEffect(()=>{
    const node=modal.current;
    node.showModal();
    first.current?.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);

  function finish(format) {
    if (leaving) return;
    const close=()=>{
      modal.current?.close();
      onClose();
      if (format) onSelect(artifact.id,format);
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) close();
    else {setLeaving(true);timer.current=setTimeout(close,120);}
  }

  return <dialog ref={modal} className={'modal export-options'+(leaving?' closing':'')} aria-labelledby={heading}
    aria-describedby={heading+'-version'} onCancel={event=>{event.preventDefault();finish();}}>
    <div className="modal-head"><h2 id={heading}>导出成果</h2>
      <button type="button" className="icon-button" onClick={()=>finish()} aria-label="关闭导出选项"><X size={19}/></button>
    </div>
    <div className="export-version" id={heading+'-version'}><strong>{artifact.result.title}</strong><span className="version">v{artifact.version}</span></div>
    <div className="export-choices">
      <button ref={first} type="button" className="button primary export-choice" aria-label="稿件与来源 ZIP" onClick={()=>finish('bundle')}>
        <Download size={19}/><span><strong>稿件与来源</strong><small>Markdown 稿件与逐条引用清单</small></span><span className="file-extension">ZIP</span>
      </button>
      <button type="button" className="button export-choice" aria-label="仅版本与来源 JSON" onClick={()=>finish('manifest')}>
        <Layers size={18}/><span><strong>仅版本与来源</strong></span><span className="file-extension">JSON</span>
      </button>
    </div>
  </dialog>;
}

async function download(id,kind) {
  if (window.hyperBot) return window.hyperBot.exportArtifact(id,kind);
  const route='/artifacts/'+id+'/export';
  if (kind==='bundle') {
    const response=await fetch(apiPath(route)+'?format=bundle',{
      headers:{'X-Hyper-Bot':'1'},cache:'no-store'
    });
    if (response.status===410) return 'material-ended';
    if (!response.ok) throw new Error((await response.json()).error || '成果包暂时无法导出。');
    const encoded=response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1];
    const filename=encoded?decodeURIComponent(encoded):'Hyper Bot 成果包.zip';
    downloadFile(await response.blob(),filename);
    return 'started';
  }
  const answer=await api(route);
  const manifest=kind==='manifest';
  const blob=new Blob([manifest?JSON.stringify(answer.manifest,null,2):answer.markdown],
    {type:(manifest?'application/json':'text/markdown')+';charset=utf-8'});
  downloadFile(blob,manifest?answer.filename.replace(/\.md$/,'-来源.json'):answer.filename);
  return 'started';
}

export function Preview({room,kind,tab,setTab,artifact,chosen,pending,draftProposal,setChosen,sourceId,setSourceId,citation,openSource,memoryRun,
  onClose,onRevise,onSelectFiles,attachments,canRevise,addingMaterials,notify,small,closing,online,refresh,materialRetention,onImportProject,onOriginalDraft,entity}) {
  const isProposal=chosen==='proposal'&&!!pending;
  const isRevision=chosen==='revision'&&!!draftProposal;
  const result=isProposal?pending:isRevision?draftProposal.result:artifact?.result;
  const selectedMaterial=room.materials.find(file=>file.id===sourceId) ??
    room.materials.find(file=>!file.endedAt) ?? room.materials[0];
  const showing=selectedMaterial?.id;
  const sheet=useRef(), preview=useRef(), focusSelectedVersion=useRef(false);
  const [returnShot,setReturnShot]=useState(null);
  const [exportId,setExportId]=useState(null);
  const [exporting,setExporting]=useState(false);
  const exportChoice=room.artifacts.find(item=>item.id===exportId&&item.result);
  const last=room.runs.at(-1);
  const review=isProposal?last.approval?.review:null;
  const viewId=isProposal?last.id:isRevision?draftProposal.id:artifact?.id;
  const citedMaterial=citation?.source===showing&&!selectedMaterial?.endedAt?selectedMaterial:null;
  const target=kind==='script'&&tab==='materials'&&citedMaterial ? citation.returnTo : null;
  const targetResult=target && (target.choice==='proposal'&&last?.id===target.viewId?pending
    :target.choice==='revision'&&draftProposal?.id===target.viewId?draftProposal.result
    :room.artifacts.find(item=>item.id===target.viewId)?.result);
  const returnTo=targetResult?.segments?.[target.index]?.evidence.some(ref=>
    ref.material===citation.source&&ref.quote===citation.text)?target:null;
  const tabs=[[kind,kind==='script'?'分镜稿':'简报'],['materials','材料',room.materials.filter(file=>!file.endedAt).length],
    ['versions','版本',room.artifacts.length+(room.projectVersions?.length||0)],['memory','记忆']];
  const active=kind===tab;
  useLayoutEffect(()=>{
    sheet.current?.scrollTo({top:0,behavior:'instant'});
    if(focusSelectedVersion.current) {
      focusSelectedVersion.current=false;
      sheet.current?.focus({preventScroll:true});
    }
  },[tab,viewId]);
  useEffect(()=>{
    if(!small)return;
    const focus=requestAnimationFrame(()=>{
      if(!preview.current?.contains(document.activeElement)) preview.current?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    });
    const trap=event=>{
      if(event.key!=='Tab'||!preview.current||document.querySelector('dialog[open]'))return;
      const items=[...preview.current.querySelectorAll('a[href],button:not([disabled]),input, [tabindex="0"]')]
        .filter(el=>el.tabIndex>=0&&el.getClientRects().length);
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
      if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
    };
    window.addEventListener('keydown',trap);
    return ()=>{cancelAnimationFrame(focus);window.removeEventListener('keydown',trap);};
  },[small]);
  async function exportNow(id,format) {
    if (exporting) return;
    setExporting(true);
    try {
      const done=await download(id,format);
      if(done==='material-ended')notify('此稿件的材料授权已结束。');
      if(done==='exists')notify('已有同名文件。请选择不同的文件名。');
      if(done==='saved')notify(format==='bundle'?'成果包已保存。':'文件已保存。');
      if(done==='started')notify('已交给浏览器下载。');
    } catch(error) {notify(error.message);}
    finally {setExporting(false);}
  }
  function key(event) {
    const current=tabs.findIndex(([id])=>id===event.target.dataset.id);
    if(current<0)return;
    const next={ArrowRight:(current+1)%tabs.length,ArrowLeft:(current+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
    if(next===undefined)return;
    event.preventDefault();setTab(tabs[next][0]);document.getElementById('tab-'+tabs[next][0]).focus();
  }

  return <aside className={'preview '+(closing?'sheet-out':'sheet-open')} id="right-preview" aria-label="会话预览" ref={preview}
    role={small?'dialog':undefined} aria-modal={small||undefined}>
    <header className="preview-head"><div><PanelRight size={19}/><h2>{entity?'档案':'预览'}</h2></div>
      <button className="icon-button" onClick={()=>onClose()} aria-label={entity?'关闭档案面板':'关闭预览'}><X size={18}/></button>
    </header>
    {entity?<div className="preview-content" ref={sheet}>{entity}</div>:<>
    <div className="tabs">
      <div className="preview-tablist" role="tablist" aria-label="预览内容" onKeyDown={key}>
        {tabs.map(([id,label,count])=><button key={id} id={'tab-'+id} type="button" role="tab" data-id={id}
          aria-selected={tab===id} aria-controls="tab-content" tabIndex={tab===id?0:-1} onClick={()=>setTab(id)}>
          {label}{count>0&&<span>{count}</span>}</button>)}
      </div>
    </div>
    <div className="preview-content" id="tab-content" role="tabpanel" aria-labelledby={'tab-'+tab} tabIndex={0} ref={sheet}>
      <div className="tab-in" key={tab}>
        {active?(result
          ? (kind==='script'?<Script key={viewId} room={room} result={result}
            caption={review?'待确认 · v'+review.version:isProposal?'待确认':isRevision?'待改稿':'v'+artifact.version}
            timing={isProposal?last.previewTiming:isRevision?draftProposal.timing:artifact.timing}
            evidenceReview={isProposal?last.previewEvidenceReview:isRevision?draftProposal.evidenceReview:artifact.evidenceReview}
            openSource={(id,quote,index)=>openSource(id,quote,{viewId,choice:chosen,index})}
            review={review} returnShot={returnShot?.viewId===viewId?returnShot:null} clearReturnShot={setReturnShot}/>
            : <Brief room={room} result={result} openSource={openSource}/>)
          : artifact?.endedAt?<div className="panel-empty"><ShieldCheck size={22}/><h3>稿件内容已清理</h3>
              <p>v{artifact.version} 的来源材料授权已结束。版本记录仍可查看。</p></div>
          : <div className="panel-empty"><FolderClosed size={22}/><h3>暂无{kind==='script'?'分镜稿':'简报'}</h3><p>完成任务后可在此查看成果。</p></div>)
        : tab==='materials' ? <Materials room={room} sourceId={showing} setSourceId={setSourceId} citation={citation}
          attachments={attachments} onSelectFiles={onSelectFiles} addingMaterials={addingMaterials} online={online} materialRetention={materialRetention}
          onImportProject={onImportProject} onOriginalDraft={onOriginalDraft} canRevise={canRevise} onSaved={async text=>{notify(text);await refresh();}}/>
        : tab==='memory'?<MemoryReceipt room={room} runId={memoryRun}/>
        : <Versions room={room} chosen={chosen} setChosen={setChosen} kind={kind}/>}
      </div>
    </div>
    <footer className="preview-foot">
      {tab==='memory'?<span/>:tab==='materials'?(citedMaterial
        ? <span><FileText size={15}/><span className="citation-file" title={citedMaterial.name}>{citedMaterial.name}</span></span>
        : <span><ShieldCheck size={15}/>勾选本轮使用的材料</span>)
        : isProposal?<span className="waiting"><ShieldCheck size={15}/>待在会话中确认写入</span>
        : isRevision&&active?<span className="waiting"><Pencil size={15}/>待改分镜 · 尚未写入</span>
        :artifact?.endedAt?<span><ShieldCheck size={15}/>来源授权已结束</span>
        :artifact?<span className="saved"><Check size={15}/>{artifact.receipt?'已保存到'+(room.projectTitle||room.title):'已保存到本机'}</span>:<span/>}
      {returnTo&&<button type="button" className="text-button source-return" onClick={()=>{
        setReturnShot(returnTo);setChosen(returnTo.choice);setTab(kind);
      }}><ChevronLeft size={16}/>返回第 {returnTo.index+1} 镜</button>}
      {tab==='versions'&&artifact?<><button className="text-button" onClick={()=>{
        focusSelectedVersion.current=true;setChosen(artifact.id);setTab(kind);
      }}><BookOpen size={16}/>查看此版</button>
        {canRevise&&!artifact.endedAt&&<button className="text-button" onClick={()=>onRevise(artifact)}><Pencil size={15}/>继续改稿</button>}</>
      :active&&artifact?.result&&!isProposal&&!isRevision?<div className="export-actions" role="group" aria-label="导出">
        <button className="text-button" disabled={exporting}
          onClick={()=>exportNow(artifact.id,'markdown')}><Download size={16}/>导出稿件</button>
        <button className="text-button source-export" disabled={exporting} onClick={()=>setExportId(artifact.id)}
          aria-label="导出选项" aria-haspopup="dialog" title="导出稿件与来源"><ChevronDown size={16}/></button>
      </div>:null}
    </footer></>}
    {exportChoice&&<ExportOptions key={exportChoice.id} artifact={exportChoice} onClose={()=>setExportId(null)} onSelect={exportNow}/>}
  </aside>;
}

