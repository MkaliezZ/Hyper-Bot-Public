import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu } from 'lucide-react';
import { api, apiPath, browseHref, currentWorkspace, rememberConversation, workspaceHref } from './client.js';
import { Chat } from './chat.jsx';
import { WorkspaceDrafts } from './drafts.js';
import { Directory, Manage, NewConversation } from './pages.jsx';
import { History, Library } from './history.jsx';
import { Recovery } from './recovery.jsx';
import {GroupChat} from './group-chat.jsx';
import { WorkspaceNav } from './workspace-nav.jsx';
import { WorkspaceMemory } from './workspace-memory.jsx';
import { TeachingConversation } from './teaching-conversation.jsx';
import { SpecialistConversation } from './specialist-conversation.jsx';
import { TeachingAssistant } from './teaching-assistant.jsx';
import { EntityArchive } from './entity-archive.jsx';
import './theme.css';

import { ActiveRunLink } from './components.jsx';

function App() {
  const [locationKey,setLocationKey] = useState(()=>{
    if (location.hash) return location.hash.slice(1);
    const initial=workspaceHref(currentWorkspace).split('#')[1];
    if(initial!=='home')window.history.replaceState(null,'','#'+initial);
    return initial;
  });
  const [workspace,setWorkspace] = useState(null);
  const [groups,setGroups]=useState([]);
  const [newChat,setNewChat]=useState(null);
  const [room,setRoom] = useState(null);
  const [drafts] = useState(()=>new WorkspaceDrafts());
  const [siteError,setSiteError] = useState('');
  const [mobileNav,setMobileNav] = useState(false);
  const [railCollapsed,setRailCollapsed] = useState(false);
  const [toast,setToast] = useState('');
  const [online,setOnline]=useState(true);
  const [reconnecting,setReconnecting]=useState(false);
  const [reconnectIssue,setReconnectIssue]=useState('');
  const versionRef = useRef(-1);
  const roomRequest = useRef(null);
  const disconnected = useRef(false);
  const reconnectTrigger=useRef(null);
  const restoreConnectionFocus=useRef(false);
  const currentId = useRef('');
  const navTrigger=useRef(null);
  const pageArea=useRef(null);
  const restoreNavFocus=useRef(false);
  const navDestination=useRef(null);
  const [viewHash,query=''] = locationKey.split('?');
  const [page,identifier=''] = viewHash.split('/');
  const params=new URLSearchParams(query);
  const requestedArtifact=params.get('artifact');
  const requestedMaterial=params.get('material');
  const requestedRun=params.get('run');
  const filters={bot:params.get('bot')??'',revision:page==='history'&&params.get('bot')?params.get('revision')??'':'',
    q:(params.get('q')??'').slice(0,100)};
  function changeFilters(next) {
    const href=browseHref(viewHash,next);
    window.history.replaceState(null,'',href);
    setLocationKey(href.slice(1));
  }
  const roomId = page==='chat' ? identifier : '';
  currentId.current=roomId;
  const refreshRoom = useCallback(async () => {
    const id=currentId.current;
    roomRequest.current?.abort();
    if(!id){setRoom(null);return;}
    const controller=new AbortController();
    roomRequest.current=controller;
    try {
      const data=await api('/rooms/'+id,undefined,{signal:controller.signal});
      if(!controller.signal.aborted && currentId.current===id) {rememberConversation(id);setSiteError('');setRoom(data);}
    } catch(error) {
      if (error.name==='AbortError' || currentId.current!==id)return;
      if (error.code==='not_found')setRoom(null);
      else setOnline(false);
      setSiteError(error.message);
    }
  },[]);
  const refresh = useCallback(async () => {
    try {
      const next=await api('/workspace');
      if (reconnectTrigger.current && document.activeElement===reconnectTrigger.current) restoreConnectionFocus.current=true;
      setOnline(true);
      setReconnectIssue('');
      if (next.version>=versionRef.current)  {versionRef.current=next.version;setWorkspace(next);}
      await refreshRoom();
      return true;
    } catch(error) {setSiteError(error.message);setOnline(false);return false;}
  },[refreshRoom]);
  useEffect(()=>{
    const controller=new AbortController();
    api('/v1/workspaces',undefined,{signal:controller.signal}).then(setGroups).catch(()=>{});
    return ()=>controller.abort();
  },[]);
  async function reconnectService() {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectIssue('');
    try {
      const result=await window.hyperBot?.reconnectHost?.();
      if (result && !result.ok) {
        setReconnectIssue(result.message);
        return;
      }
      if (!await refresh()) setReconnectIssue('本机服务暂未恢复。请重试。');
    } catch {
      setReconnectIssue('无法连接本机服务。请重试。');
    } finally {
      setReconnecting(false);
    }
  }
  const connectionMessage=reconnecting?'正在重连本机服务…':reconnectIssue||'本机服务已断开 · 显示最近确认的状态';
  useEffect(()=>{
    const move=()=>{setLocationKey(location.hash.slice(1)||'home');setMobileNav(false);setSiteError('');};
    addEventListener('hashchange',move);
    let source,reconnect;
    const connect=()=>{
      source=new EventSource(apiPath('/events'));
      source.onmessage=event=>{if(Number(event.data)>versionRef.current||disconnected.current){disconnected.current=false;void refresh();}};
      source.onerror=()=>{
        disconnected.current=true;
        setOnline(false);
        source.close();
        reconnect=setTimeout(connect,1200);
      };
    };
    connect();
    const saveCurrent=()=>{void drafts.flush(currentId.current);};
    const foreground=()=>{if(document.hidden)saveCurrent();else void refresh();};
    document.addEventListener('visibilitychange',foreground);
    addEventListener('pagehide',saveCurrent);
    void refresh();
    return ()=>{removeEventListener('hashchange',move);document.removeEventListener('visibilitychange',foreground);
      removeEventListener('pagehide',saveCurrent);roomRequest.current?.abort();clearTimeout(reconnect);source.close();};
  },[refresh,drafts]);
  useLayoutEffect(()=>{
    if (!online || !restoreConnectionFocus.current) return;
    restoreConnectionFocus.current=false;
    const area=pageArea.current;
    const target=area?.querySelector('main:not([inert]) #message:not(:disabled)') ??
      area?.querySelector('main:not([inert]) h1') ?? area?.querySelector('#right-preview [role="tab"][aria-selected="true"]');
    if (target?.tagName==='H1') target.tabIndex=-1;
    target?.focus({preventScroll:true});
  },[online]);
  useEffect(()=>{void refreshRoom();},[roomId,refreshRoom]);
  useLayoutEffect(()=>drafts.observe(room,{visible:true}),[drafts,room]);
  useEffect(()=>drafts.setOnline(online),[drafts,online]);
  useEffect(()=>{
    if (['history','library','recovery','manage','memory','entity'].includes(page)) document.querySelector('.route-page')?.scrollTo({top:0});
  },[page,identifier]);
  useEffect(()=>{
    if(!toast)return;
    const timer=setTimeout(()=>setToast(''),3400);
    return ()=>clearTimeout(timer);
  },[toast]);
  const closeNav=useCallback(()=>{
    navDestination.current=null;
    restoreNavFocus.current=true;
    setMobileNav(false);
  },[]);
  useEffect(()=>{
    if(!mobileNav)return;
    const nav=document.getElementById('workspace-nav');
    const focusable=()=>[...nav.querySelectorAll('a[href],input:not([disabled]),button:not([disabled]),summary')].filter(el=>el.getClientRects().length);
    focusable()[0]?.focus();
    const end=event=>{
      if(event.defaultPrevented||event.target.closest?.('dialog[open]'))return;
      if(event.key==='Escape'){event.preventDefault();closeNav();return;}
      if(event.key!=='Tab')return;
      const items=focusable();
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
      if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
    };
    const width=matchMedia('(max-width: 1000px)');
    const resized=()=>{if(!width.matches)closeNav();};
    window.addEventListener('keydown',end);
    width.addEventListener('change',resized);
    return ()=>{
      window.removeEventListener('keydown',end);
      width.removeEventListener('change',resized);
    };
  },[mobileNav,closeNav]);
  function chooseNav(event) {
    const link=event.target.closest('a[href^="#"]');
    if(!mobileNav||!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    if(link.hash===location.hash)closeNav();
    else navDestination.current=link.hash.slice(1)||'home';
  }
  function openNav() {
    if(matchMedia('(max-width: 1000px)').matches)setMobileNav(true);
    else setRailCollapsed(false);
  }
  function searchConversations(query) {
    const target=browseHref('history',{q:query});
    if(mobileNav) {
      navDestination.current=target.slice(1);
      setMobileNav(false);
    }
    location.hash=target;
  }
  function beginConversation(bot) {
    setMobileNav(false);
    setNewChat(bot);
  }
  const navButton=<button type="button" ref={navTrigger} className="icon-button show-nav" disabled={!workspace}
    aria-label="打开工作区导航" aria-controls="workspace-nav"
    aria-expanded={mobileNav || !railCollapsed && !matchMedia('(max-width: 1000px)').matches} onClick={openNav}><Menu size={20}/></button>;
  const ready=workspace && room?.id===roomId, bot=ready&&workspace.bots.find(bot=>bot.id===room.botId&&bot.revision===room.revision);
  useLayoutEffect(()=>{
    if(mobileNav)return;
    if(restoreNavFocus.current) {
      restoreNavFocus.current=false;
      const trigger=navTrigger.current;
      (trigger?.getClientRects().length?trigger:document.querySelector('#workspace-nav .brand'))?.focus({preventScroll:true});
    } else if(navDestination.current===locationKey) {
      const title=pageArea.current?.querySelector('main h1');
      if(!title)return;
      navDestination.current=null;
      title.tabIndex=-1;
      title.focus({preventScroll:true});
    }
  },[mobileNav,locationKey,ready]);
  const active=workspace?.active;
  const owner=active&&workspace.conversations.find(room=>room.id===active.conversation)?.title;
  return <div className={'app-shell'+(railCollapsed?' nav-collapsed':'')+(roomId||page==='group'?' is-chat':'')}>
    {workspace&&<WorkspaceNav workspace={workspace} groups={groups.length?groups:[workspace.workspace]}
      route={page} roomId={roomId} open={mobileNav} online={online} onNew={beginConversation}
      onSearch={searchConversations} searchQuery={filters.q} refresh={refresh} notify={setToast}
      onCollapse={()=>setRailCollapsed(true)} onClose={closeNav} onNavigate={chooseNav}/>}
    {mobileNav&&<button type="button" tabIndex={-1} className="nav-scrim" aria-label="关闭导航" onClick={closeNav}/>}
    <div className="page-area" ref={pageArea} inert={mobileNav}>
      {workspace&&!online&&<div className="connection-banner">
        <span role="status"><span className="status-in" key={connectionMessage}>{connectionMessage}</span></span>
        <button className="text-button" type="button" ref={reconnectTrigger} aria-disabled={reconnecting} onClick={reconnectService}>重连</button>
      </div>}
      {workspace&&page==='group'&&currentWorkspace!=='personal'?<GroupChat workspace={workspace} navButton={navButton}/>:workspace&&ready&&bot ? <>
        {active&&active.conversation!==roomId&&<div className="chat-run-bar">
          <span title={owner}>{owner||'当前任务'}</span><ActiveRunLink run={active} owner={owner}/>
        </div>}
        {bot.kind==='teaching'?(bot.target==='bot'&&bot.trial
          ?<TeachingAssistant key={roomId} room={room} bot={bot} workspace={workspace} navButton={navButton} online={online} refresh={refresh}/>
          :<TeachingConversation key={roomId} room={room} bot={bot} navButton={navButton}/>)
        :bot.kind==='workbench'?<SpecialistConversation key={roomId} room={room} bot={bot} workspace={workspace} navButton={navButton}
          refresh={refresh} online={online}/>
        :<Chat key={roomId} room={room} bot={bot} workspace={workspace} drafts={drafts} navButton={navButton} refresh={refresh} notify={setToast}
          onNew={beginConversation}
          requestedArtifact={requestedArtifact} requestedMaterial={requestedMaterial} requestedRun={requestedRun} online={online}/>}
      </>
        : <main className="route-page">
          <header className="page-bar">{navButton}<span className="page-bar-label" title={workspace?.workspace.name}>{workspace?.workspace.name}</span>
            {active&&<ActiveRunLink run={active} owner={owner}/>}
          </header>
          {!workspace||roomId ? <div className="load-message" role="status">{siteError||'正在读取本机工作区…'}{siteError&&<button className="button" onClick={refresh}>重试</button>}</div>
            : <div className="page-content view-in" key={page}>
              {page==='manage'?<Manage workspace={workspace} refresh={refresh} notify={setToast} online={online}
                requestedSection={identifier} botId={params.get('bot')} revision={params.get('revision')} roomId={params.get('room')}/>
                :page==='library'?<Library workspace={workspace} groupId={identifier} filters={filters} onChange={changeFilters}/>
                :page==='history'?<History workspace={workspace} filters={filters} onChange={changeFilters}/>
                :page==='recovery'?<Recovery workspace={workspace} selected={identifier} online={online} refresh={refresh} notify={setToast}/>
                :page==='memory'?<WorkspaceMemory workspace={workspace} online={online} notify={setToast}/>
                :page==='entity'&&workspace.entityArchive?<EntityArchive version={workspace.version} selected={identifier}
                  online={online} notify={setToast} refresh={refresh}/>
                :<Directory workspace={workspace} selected={identifier} home={page==='home'} refresh={refresh} online={online}/>}
            </div>}
        </main>}
    </div>
    {newChat&&<NewConversation bot={newChat} originalWorkbench={workspace.originalWorkbench} onClose={()=>setNewChat(null)}
      roomReady={id=>{setNewChat(null);location.hash='chat/'+id;void refresh();}}/>}
    {toast&&<div className="toast" role="status">{toast}</div>}
  </div>;
}

createRoot(document.getElementById('app')).render(<App />);

