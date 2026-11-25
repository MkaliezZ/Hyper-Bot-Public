import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronRight, FileText, FolderClosed, MessageSquare, Search, X } from 'lucide-react';
import { api, artifactHref, browseHref, clock, day } from './client.js';
import { BotMark } from './components.jsx';

const sourceNames={original:'独立 Self Media Workbench',workbench:'Self Media Workbench',conversation:'本机会话'};
const versionTitle=version=>version.title??'稿件内容已清理';
const normalized=value=>value.normalize('NFKC').toLocaleLowerCase('zh-CN');
const terms=query=>normalized(query).trim().split(/\s+/).filter(Boolean);
const matches=(words,...values)=>{
  if (!words.length)return true;
  const space=normalized(values.filter(Boolean).join('\n'));
  return words.every(word=>space.includes(word));
};

function botOptions(workspace) {
  const versions=workspace.bots.filter(bot=>bot.status!=='draft')
    .sort((a,b)=>Number(a.status==='enabled')-Number(b.status==='enabled')||a.revision-b.revision);
  return [...new Map(versions.map(bot=>[bot.id,bot])).values()];
}

function describeBot(workspace,botId,revision) {
  const bot=workspace.bots.find(item=>item.id===botId&&item.revision===revision);
  return (bot?.name??botId)+' · r'+revision+(bot?.status==='disabled'?' · 已停用':'');
}

function SearchBar({workspace,filters,onChange,placeholder}) {
  const options=botOptions(workspace);
  function change(key,value) {
    onChange({...filters,[key]:value,...(key==='bot'?{revision:''}:{})});
  }
  return <div className="browse-controls" role="search" aria-label="筛选列表">
    <div className="browse-search">
      <Search size={17} aria-hidden="true"/>
      <input aria-label={placeholder} placeholder={placeholder} type="search" maxLength={100} value={filters.q}
        onChange={event=>change('q',event.target.value)}/>
      {filters.q&&<button className="icon-button" type="button" aria-label="清除搜索" onClick={()=>change('q','')}><X size={16}/></button>}
    </div>
    <div className="browse-filter">
      <select aria-label="按 Bot 筛选" value={filters.bot} onChange={event=>change('bot',event.target.value)}>
        <option value="">全部 Bot</option>
        {options.map(bot=><option value={bot.id} key={bot.id}>{bot.name}{bot.status==='disabled'?' · 已停用':''}</option>)}
      </select>
    </div>
  </div>;
}

function EmptyList({title,filtered,onChange}) {
  return <div className="empty-page"><Search size={24}/><h2>{title}</h2>
    {filtered?<button type="button" className="button" onClick={()=>onChange({bot:'',q:''})}>清除筛选</button>
      :<a href="#bots" className="button">选择 Bot<ArrowRight size={16}/></a>}
  </div>;
}

export function History({workspace,filters,onChange}) {
  const words=terms(filters.q);
  const filtered=!!(filters.bot||words.length);
  const visible=workspace.conversations.filter(room=>(!filters.bot||room.botId===filters.bot)&&
    (!filters.revision||String(room.revision)===filters.revision)&&
    matches(words,room.title,room.projectTitle,describeBot(workspace,room.botId,room.revision)));
  return <>
    <div className="section-head"><div><h1>会话记录</h1><p>按 Bot 找回以前的任务与草稿。</p></div>
      <a className="button" href="#bots"><ArrowRight size={16}/>Bot 市场</a></div>
    <SearchBar workspace={workspace} filters={filters} onChange={onChange} placeholder="搜索会话或项目"/>
    {filters.revision&&<div className="browse-version">
      <span>{describeBot(workspace,filters.bot,Number(filters.revision))}</span>
      <button type="button" className="text-button" onClick={()=>onChange({...filters,revision:''})}>查看所有版本</button>
    </div>}
    {visible.length?<div className="browse-results">
      <p className="browse-count" role="status">{visible.length} 个会话</p>
      <div className="history-list">{visible.map(room=>{
        const bot=workspace.bots.find(item=>item.id===room.botId&&item.revision===room.revision);
        return <a className="page-row" href={'#chat/'+room.id} key={room.id}>
          {bot?<BotMark kind={bot.kind}/>:<MessageSquare size={17}/>}
          <span className="history-row-title"><strong>{room.title}</strong><small>{describeBot(workspace,room.botId,room.revision)}
            {room.projectTitle&&room.projectTitle!==room.title?' · '+room.projectTitle:''}</small></span>
          <time dateTime={room.updatedAt}>{day(room.updatedAt)} {clock(room.updatedAt)}</time><ChevronRight size={16}/>
        </a>;
      })}</div>
    </div>:<EmptyList title={filtered?'没有匹配的会话':'还没有会话'} filtered={filtered} onChange={onChange}/>}
  </>;
}

function ProjectRow({group,preferred,filters}) {
  return <article className="collection-card">
    <div className="collection-entry">
      <span className="file-icon" aria-hidden="true">{group.kind==='script'?<FolderClosed size={19}/>:<FileText size={19}/>}</span>
      <div>
        <h2><a href={browseHref('library/'+group.id,filters)}>{group.title}</a></h2>
        <p>{group.kind==='script'?'口播分镜稿':'素材简报'} · {group.versions.length} 个版本</p>
      </div>
    </div>
    <div className="collection-actions">
      {preferred?.title&&<a className="button compact" href={artifactHref(preferred)}>打开 v{preferred.version}<ArrowRight size={15}/></a>}
      <a className="text-button" href={browseHref('library/'+group.id,filters)}
        aria-label={'查看 '+group.title+' 的版本'}>查看版本<ChevronRight size={15}/></a>
    </div>
  </article>;
}

function ProjectMaterials({groupId,label,available}) {
  const [snapshot,setSnapshot]=useState(null);
  const current=available?.id;
  useEffect(()=>{
    if (!current) return;
    const controller=new AbortController();
    api('/library/'+groupId,undefined,{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted)setSnapshot({id:current,result});
    }).catch(error=>{
      if(!controller.signal.aborted)setSnapshot({id:current,error:error.message});
    });
    return ()=>controller.abort();
  },[groupId,current]);
  if (!current) return null;
  const entry=snapshot?.id===current?snapshot:null;
  const files=entry?.result?.version?.id===current?entry.result.files:[];
  return <section className="collection-panel">
    <h2>{label}</h2>
    {!entry?<p className="muted" role="status">正在读取材料…</p>
      :entry.error?<p className="form-error" role="alert">{entry.error}</p>
      :files.length?<><p className="collection-note">v{available.version} 的授权材料</p>
        {files.map(file=><a className="collection-conversation" key={file.id}
          href={artifactHref(available)+'&material='+file.id}><FileText size={15}/><span>{file.name}</span><ChevronRight size={14}/></a>)}</>
        :<p className="muted">当前版本暂无可读材料。</p>}
  </section>;
}

function ProjectDetail({group,filters,workspace}) {
  const heading=useRef();
  useEffect(()=>heading.current?.focus({preventScroll:true}),[]);
  const newest=group.versions[0];
  const available=group.versions.find(version=>version.title);
  const conversations=[...new Map(group.versions.map(version=>[version.conversation,version])).values()];
  return <div className="project-detail status-in">
    <div className="section-head"><div><h1 tabIndex={-1} ref={heading}>{group.title}</h1>
      <p>{group.kind==='script'?'口播分镜稿':'素材简报'} · {group.versions.length} 个版本</p></div>
      <a className="button" href={browseHref('library',filters)}><ArrowLeft size={16}/>成果库</a></div>
    <div className="collection-layout">
      <div className="collection-main">
        <section className="collection-feature">
          <span className="file-icon"><FileText size={22}/></span>
          <div><h2>{versionTitle(newest)}</h2><p>最新收录 v{newest.version} · {day(newest.createdAt)}</p></div>
          {available&&<a className="button primary compact" href={artifactHref(available)}>打开{available.id===newest.id?'最新版':''} v{available.version}<ArrowRight size={15}/></a>}
        </section>
        <section className="collection-panel" aria-labelledby="collection-versions">
          <h2 id="collection-versions">版本记录</h2>
          {group.versions.map(version=><a className="collection-version" key={version.id} href={artifactHref(version)}>
            <span className="version-id">v{version.version}</span>
            <span><strong>{versionTitle(version)}</strong><small>{version.roomTitle} · 任务 {version.run.slice(0,8)}</small></span>
            <ChevronRight size={16}/>
          </a>)}
        </section>
      </div>
      <div className="collection-main">
        <section className="collection-panel">
          <h2>{group.kind==='script'?'项目来源':'成果来源'}</h2>
          <dl><dt>来源</dt><dd>{sourceNames[group.source]}</dd>
            <dt>最新一版</dt><dd>{describeBot(workspace,newest.botId,newest.botRevision)}</dd></dl>
        </section>
        <ProjectMaterials groupId={group.id} available={available} label={group.kind==='script'?'项目材料':'会话材料'}/>
        <section className="collection-panel">
          <h2>相关会话</h2>
          {conversations.map(version=><a className="collection-conversation" key={version.conversation} href={'#chat/'+version.conversation}>
            <MessageSquare size={15}/><span>{version.roomTitle}</span><ChevronRight size={14}/>
          </a>)}
        </section>
      </div>
    </div>
  </div>;
}

export function Library({workspace,groupId,filters,onChange}) {
  const [snapshot,setSnapshot]=useState(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    const version=workspace.version;
    api('/library',undefined,{signal:controller.signal}).then(groups=>{
      if(!controller.signal.aborted)setSnapshot({version,groups});
    }).catch(error=>{
      if(!controller.signal.aborted)setSnapshot({version,error:error.message});
    });
    return ()=>controller.abort();
  },[workspace.version,retry]);
  const latest=snapshot?.version===workspace.version?snapshot:null;
  const preferred=latest?.groups?.find(group=>group.id===groupId);
  if (preferred) return <ProjectDetail key={preferred.id} group={preferred} filters={filters} workspace={workspace}/>;

  const words=terms(filters.q);
  const filtered=!!(filters.bot||words.length);
  const rows=(latest?.groups??[]).flatMap(group=>{
    const hits=group.versions.filter(version=>(!filters.bot||version.botId===filters.bot)&&
      matches(words,group.title,version.title,version.roomTitle,'v'+version.version,
        describeBot(workspace,version.botId,version.botRevision)));
    return hits.length?[{group,preferred:hits.find(item=>item.title)}]:[];
  });
  return <>
    <div className="section-head"><div><h1>成果库</h1><p>打开项目的最新稿，或找回历史版本。</p></div></div>
    <SearchBar workspace={workspace} filters={filters} onChange={onChange} placeholder="搜索项目或稿件"/>
    {!latest?<p className="browse-status" role="status">正在读取成果…</p>
      :latest.error?<div className="browse-status"><p role="alert" className="form-error">{latest.error}</p>
        <button className="button compact" type="button" onClick={()=>{setSnapshot(null);setRetry(retry+1);}}>重新读取</button></div>
      :<>{groupId&&<p className="browse-status" role="status">当前工作区找不到此成果。</p>}
        {rows.length?<div className="browse-results"><p className="browse-count" role="status">{rows.length} 项成果</p>
          <div className="collections">{rows.map(({group,preferred})=><ProjectRow key={group.id} group={group} preferred={preferred} filters={filters}/>)}</div>
        </div>:<EmptyList title={filtered?'没有匹配的成果':'还没有成果'} filtered={filtered} onChange={onChange}/>}</>}
  </>;
}

