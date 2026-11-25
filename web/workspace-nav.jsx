import React, { useEffect, useRef, useState } from 'react';
import { Archive, Check, ChevronsUpDown, Grid2X2, History, House, LayoutPanelLeft, Link2, MoreHorizontal,
  Plus, Search, Settings2, X } from 'lucide-react';
import { api, workspaceHref } from './client.js';
import { BotMark } from './components.jsx';

function WorkspaceMark({name}) {
  return <span className="workspace-mark" aria-hidden="true">{[...name][0]}</span>;
}

function WorkspacePicker({active,groups,online,onClose}) {
  const dialog=useRef();
  const [name,setName]=useState('');
  const [creating,setCreating]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{dialog.current.showModal();},[]);
  function close() {
    if (busy) return;
    dialog.current.close();
    onClose();
  }
  async function create(event) {
    event.preventDefault();
    if (!name.trim()||!online||busy) return;
    setBusy(true);setError('');
    try {
      const group=await api('/v1/workspaces',{name:name.trim()});
      location.assign(workspaceHref(group.id));
    } catch(error) {setError(error.message);setBusy(false);}
  }
  return <dialog ref={dialog} className="modal workspace-dialog" aria-labelledby="workspace-title"
    onCancel={event=>{event.preventDefault();close();}}>
    <header className="modal-head"><h2 id="workspace-title">切换工作区</h2>
      <button className="icon-button" type="button" aria-label="关闭切换工作区" onClick={close}><X size={18}/></button></header>
    <div className="workspace-options">
      {groups.map(group=>group.id===active.id
        ?<div className="workspace-option current" key={group.id} aria-current="true">
          <WorkspaceMark name={group.name}/><strong>{group.name}</strong><Check size={18}/></div>
        :<a className="workspace-option" key={group.id} href={workspaceHref(group.id)}>
          <WorkspaceMark name={group.name}/><strong>{group.name}</strong></a>)}
    </div>
    {creating?<form className="workspace-form" onSubmit={create}>
      <label>工作区名称<input autoFocus maxLength={40} required value={name} onChange={event=>setName(event.target.value)}/></label>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button primary" type="submit" disabled={!online||!name.trim()||busy}>
        {busy?'正在创建…':'创建并进入'}</button></div>
    </form>:<button className="button" type="button" disabled={!online} onClick={()=>setCreating(true)}><Plus size={16}/>新建工作区</button>}
  </dialog>;
}

export function WorkspaceNav({workspace,groups,route,roomId,open,onClose,onCollapse,onNavigate,onNew,online}) {
  const [picker,setPicker]=useState(false);
  const menu=useRef();
  const bots=workspace.bots.filter(bot=>bot.status==='enabled'&&workspace.installedBots.includes(bot.id));
  const currentRoom=workspace.conversations.find(room=>room.id===roomId);
  const currentBot=bots.find(bot=>bot.id===currentRoom?.botId)??(bots.length===1?bots[0]:null);
  const activeBot=workspace.conversations.find(room=>room.id===workspace.active?.conversation)?.botId;
  const active=workspace.workspace;
  useEffect(()=>{if(menu.current)menu.current.open=false;},[route,roomId]);
  return <aside className={'rail'+(open?' open':'')} aria-label="工作区导航" id="workspace-nav"
    role={open?'dialog':undefined} aria-modal={open||undefined} onClick={onNavigate}>
    <div className="rail-head">
      <a className="brand" href="#home"><img src="/media/mark.svg" alt=""/>Hyper Bot</a>
      <button className="icon-button desktop-control" aria-label="收起工作区导航" onClick={onCollapse}><LayoutPanelLeft size={17}/></button>
      <button className="icon-button mobile-control" aria-label="关闭工作区导航" onClick={onClose}><X size={19}/></button>
    </div>
    <nav className="rail-body">
      <button type="button" className="workspace-switch" aria-haspopup="dialog" onClick={()=>setPicker(true)}>
        <WorkspaceMark name={active.name}/>
        <span><strong>{active.name}</strong><small>切换工作区</small></span>
        <ChevronsUpDown size={14}/>
      </button>
      <div className="workspace-tools">
        <a className="nav-line" href="#history" aria-current={route==='history'?'page':undefined}><Search/>搜索会话</a>
        {currentBot&&!currentBot.blocked&&online
          ?<button className="icon-button" type="button" title="新建会话" aria-label="新建会话" onClick={()=>onNew(currentBot)}><Plus size={18}/></button>
          :<a className="icon-button" href="#bots" title="选择 Bot" aria-label="选择 Bot"><Plus size={18}/></a>}
      </div>
      <div className="nav-label">专项 Bot</div>
      {bots.map(bot=>{
        const room=workspace.conversations.find(item=>item.botId===bot.id);
        const waiting=bot.id===activeBot&&workspace.active.state==='waiting_approval';
        return <a key={bot.id} className="nav-line workspace-bot" href={room?'#chat/'+room.id:'#bots/'+bot.id}
          aria-current={currentRoom?.botId===bot.id?'page':undefined}>
          <BotMark kind={bot.kind}/><span className="workspace-bot-copy"><strong>{bot.name}</strong>
            <small>{waiting?'待确认写入':room?.title??'打开 Bot'}</small></span>
          {waiting&&<i className="status-dot" aria-hidden="true"/>}
        </a>;
      })}
      {!bots.length&&<a className="nav-line workspace-empty" href="#bots"><Plus/>添加专项 Bot</a>}
    </nav>
    <div className="rail-foot workspace-bottom">
      <a className="nav-line" href="#bots" aria-current={route==='bots'?'page':undefined}><Grid2X2/>Bot 市场</a>
      <details className="workspace-more" ref={menu} onBlur={event=>{
        if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;
      }} onKeyDown={event=>{
        if(event.key==='Escape'&&menu.current?.open){event.stopPropagation();menu.current.open=false;menu.current.querySelector('summary').focus();}
      }}>
        <summary className="icon-button" role="button" aria-label="工作区菜单" title="工作区菜单"><MoreHorizontal size={19}/></summary>
        <div className="workspace-menu">
          <a className="nav-line" href="#home"><House/>工作台</a>
          <a className="nav-line" href="#library"><Archive/>成果库</a>
          <a className="nav-line" href="#memory"><Link2/>工作区记忆</a>
          <a className="nav-line" href="#recovery"><History/>断线核对
            {workspace.pendingWriteChecks>0&&<small className="recovery-count">{workspace.pendingWriteChecks}</small>}</a>
          <a className="nav-line" href="#manage"><Settings2/>维护中心</a>
        </div>
      </details>
    </div>
    {picker&&<WorkspacePicker active={active} groups={groups} online={online} onClose={()=>setPicker(false)}/>}
  </aside>;
}
