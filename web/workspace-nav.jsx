import React, { useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, Check, ChevronsUpDown, ContactRound, Grid2X2, History, House, LayoutPanelLeft, Link2, MoreHorizontal,
  Users, Plus, Search, Settings2, X } from 'lucide-react';
import { api, browseHref, currentWorkspace, workspaceHref } from './client.js';
import { BotMark } from './components.jsx';
import { useDetailsMenu } from './details-menu.js';

function WorkspaceMark({name}) {
  return <span className="workspace-mark" aria-hidden="true">{[...name][0]}</span>;
}

const searchStorageKey='hyper-bot:sidebar-search:'+currentWorkspace;
function readSearches() {
  try {
    const items=JSON.parse(sessionStorage.getItem(searchStorageKey)??'[]');
    return Array.isArray(items)?items.filter(item=>typeof item==='string'&&item.length>0&&item.length<=100).slice(0,5):[];
  } catch {return [];}
}

export function FolderField({folder,setFolder,disabled,onError}) {
  const [picking,setPicking]=useState(false);
  return <label>群组文件夹<div className="group-folder-field">
    <input required value={folder} placeholder="选择文件夹或输入绝对路径" disabled={disabled||picking} onChange={e=>setFolder(e.target.value)}/>
    <button type="button" className="button compact" disabled={disabled||picking} onClick={async()=>{
      setPicking(true);onError('');
      try{const result=await api('/choose-group-folder',{});if(result.folder)setFolder(result.folder);}
      catch(error){onError(error.message);}finally{setPicking(false);}
    }}>{picking?'选择中…':'选择文件夹'}</button></div></label>;
}

function WorkspacePicker({catalog,online,onClose}) {
  const dialog=useRef();
  const [name,setName]=useState(''),[folder,setFolder]=useState(''),[members,setMembers]=useState([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{dialog.current.showModal();},[]);
  async function create(event) {
    event.preventDefault();
    if (!members.length||busy) return;
    setBusy(true);setError('');
    try {
      const group=await api('/v1/workspaces',{name:name.trim(),folder:folder.trimStart(),bots:members});
      location.assign('/w/'+group.id+'/#group');
    } catch(error) {setError(error.message);setBusy(false);}
  }
  return <dialog ref={dialog} className="modal workspace-dialog" aria-labelledby="workspace-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header className="modal-head"><h2 id="workspace-title">新建群组</h2><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭"><X size={18}/></button></header>
    <form className="workspace-form" onSubmit={create}>
      <label>群组名称<input autoFocus maxLength={40} required value={name} onChange={e=>setName(e.target.value)}/></label>
      <FolderField folder={folder} setFolder={setFolder} disabled={busy} onError={setError}/>
      <fieldset className="group-member-pick"><legend>群组成员</legend>
        {catalog.filter(b=>b.status==='enabled').map(bot=><label key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} onChange={e=>setMembers(list=>e.target.checked?[...list,bot.id]:list.filter(id=>id!==bot.id))}/><BotMark bot={bot}/>{bot.name}</label>)}
      </fieldset>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button primary" type="submit" disabled={!online||!name.trim()||!folder.trim()||!members.length||busy}>
        {busy?'正在创建…':'创建群组'}</button></div>
    </form></dialog>;
}

export function WorkspaceNav({workspace,groups,route,roomId,open,onClose,onCollapse,onNavigate,onNew,onSearch,searchQuery,online,refresh,notify}) {
  const [picker,setPicker]=useState(false);
  const [list,setList]=useState(currentWorkspace==='personal'?'bot':'group');
  const [search,setSearch]=useState('');
  const [searches,setSearches]=useState(readSearches);
  const [removing,setRemoving]=useState(null);
  const menu=useDetailsMenu();
  const plaza=useRef(null);
  const sidebarBots=workspace.sidebarBots??workspace.installedBots;
  const bots=workspace.bots.filter(bot=>bot.status==='enabled'&&sidebarBots.includes(bot.id));
  const currentRoom=workspace.conversations.find(room=>room.id===roomId);
  const currentBot=bots.find(bot=>bot.id===currentRoom?.botId)??(bots.length===1?bots[0]:null);
  const activeBot=workspace.conversations.find(room=>room.id===workspace.active?.conversation)?.botId;
  const active=workspace.workspace;
  function submitSearch(event) {
    event.preventDefault();
    const query=search.trim();
    if(!query)return;
    const recent=[query,...searches.filter(value=>value!==query)].slice(0,5);
    setSearches(recent);
    try {sessionStorage.setItem(searchStorageKey,JSON.stringify(recent));}
    catch { /* Search remains available for this page. */ }
    onSearch(query);
  }
  async function removeBot(event,bot) {
    if(removing||!online)return;
    const restoreFocus=document.activeElement===event.currentTarget;
    setRemoving(bot.id);
    try {
      await api('/bot-instances/remove-from-sidebar',{botId:bot.id});
      if(restoreFocus)plaza.current?.focus({preventScroll:true});
      await refresh();
      notify('已从侧栏移除「'+bot.name+'」。');
    } catch(error) {notify(error.message);}
    finally {setRemoving(null);}
  }
  useEffect(()=>{if(menu.ref.current)menu.ref.current.open=false;},[menu.ref,route,roomId,open]);
  return <aside className={'rail'+(open?' open':'')} aria-label="工作区导航" id="workspace-nav"
    role={open?'dialog':undefined} aria-modal={open||undefined} onClick={onNavigate}>
    <div className="rail-head">
      <a className="brand" href="#home"><img src="/media/mark.svg" alt=""/>Hyper Bot</a>
      <button className="icon-button desktop-control" aria-label="收起工作区导航" onClick={onCollapse}><LayoutPanelLeft size={17}/></button>
      <button className="icon-button mobile-control" aria-label="关闭工作区导航" onClick={onClose}><X size={19}/></button>
    </div>
    {active.id==='personal'&&<nav className="rail-shortcuts" aria-label="工作区工具">
      <a className="nav-line" href="#students" aria-current={route==='students'?'page':undefined}><ContactRound/>学员档案</a>
    </nav>}
    <nav className="rail-body">
      {active.id!=='personal'&&route!=='group'&&<a className="nav-line" href="#group"><Users size={17}/>{active.name} · 群聊</a>}
      <div className="workspace-tools">
        <form className="rail-search" role="search" aria-label="侧栏搜索会话" onSubmit={submitSearch}>
          <input type="search" maxLength={100} placeholder="搜索会话" aria-label="搜索会话" value={search}
            onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{
              if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();
            }}/>
          <button className="icon-button" type="submit" aria-label="提交搜索" disabled={!search.trim()}><Search size={17}/></button>
        </form>
        {currentBot&&!currentBot.blocked&&online
          ?<button className="icon-button" type="button" title="新建会话" aria-label="新建会话" onClick={()=>onNew(currentBot)}><Plus size={18}/></button>
          :<a className="icon-button" href="#bots" title="选择 Bot" aria-label="选择 Bot"><Plus size={18}/></a>}
      </div>
      {searches.length>0&&<div className="rail-searches" aria-label="搜索会话">
        {searches.map(query=><a key={query} className="nav-line" title={'搜索：'+query}
          href={browseHref('history',{q:query})} aria-current={route==='history'&&searchQuery===query?'page':undefined}>
          <Search/><span>{query}</span></a>)}
      </div>}
      <div className="rail-tabs" role="group" aria-label="会话类型">
        <button aria-pressed={list==='bot'} onClick={()=>{if(currentWorkspace!=='personal')location.assign(workspaceHref('personal'));else setList('bot');}}>Bot</button>
        <button aria-pressed={list==='group'} onClick={()=>setList('group')}>群组</button>
      </div>
      {list==='group'?<div className="rail-groups">
        <button className="nav-line" onClick={()=>setPicker(true)}><Plus size={16}/>新建群组</button>
        {groups.filter(g=>g.id!=='personal').map(group=><a className="nav-line" key={group.id} aria-current={group.id===active.id?'page':undefined} href={'/w/'+group.id+'/#group'}><WorkspaceMark name={group.name}/>{group.name}</a>)}
      </div>:<>
      {bots.map(bot=>{
        const room=workspace.conversations.find(item=>item.botId===bot.id);
        const waiting=bot.id===activeBot&&workspace.active.state==='waiting_approval';
        return <div className="workspace-bot-row" key={bot.id}><a className="nav-line workspace-bot" href={room?'#chat/'+room.id:'#bots/'+bot.id}
          aria-current={currentRoom?.botId===bot.id?'page':undefined}>
          <BotMark bot={bot}/><span className="workspace-bot-copy"><strong>{bot.name}</strong>
            <small>{waiting?'待确认写入':room?.title??'打开 Bot'}</small></span>
          {waiting&&<i className="status-dot" aria-hidden="true"/>}
        </a><button type="button" className="icon-button sidebar-bot-remove" title="从侧栏移除"
          aria-label={'从侧栏移除 '+bot.name} disabled={!online||!!removing} onClick={event=>void removeBot(event,bot)}><X size={15}/></button></div>;
      })}
      {!bots.length&&<a className="nav-line workspace-empty" href="#bots"><Plus/>添加 Bot</a>}</>}
    </nav>
    <div className="rail-foot workspace-bottom">
      <a ref={plaza} className="nav-line" href="#bots" aria-current={route==='bots'?'page':undefined}><Grid2X2/>Bot广场</a>
      <details className="workspace-more" {...menu} onClick={event=>{
        if(event.target.closest('a')?.hash===location.hash)event.currentTarget.open=false;
      }}>
        <summary className="icon-button" role="button" aria-label="工作区菜单" title="工作区菜单"><MoreHorizontal size={19}/></summary>
        <div className="workspace-menu">
          <a className="nav-line" href="#home"><House/>工作台</a>
          <a className="nav-line" href="#library"><Archive/>成果库</a>
          {workspace.entityArchive&&<a className="nav-line" href="#entity" aria-current={route==='entity'?'page':undefined}>
            <BookOpen/>档案</a>}
          <a className="nav-line" href="#memory"><Link2/>工作区记忆</a>
          <a className="nav-line" href="#recovery"><History/>断线核对
            {workspace.pendingWriteChecks>0&&<small className="recovery-count">{workspace.pendingWriteChecks}</small>}</a>
          <a className="nav-line" href="#manage"><Settings2/>维护中心</a>
        </div>
      </details>
    </div>
    {picker&&<WorkspacePicker catalog={workspace.bots} online={online} onClose={()=>setPicker(false)}/>}
  </aside>;
}
