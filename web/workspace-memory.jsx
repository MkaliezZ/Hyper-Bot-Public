import React, { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Link2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, runHref } from './client.js';

function botNames(workspace) {
  return new Map(workspace.bots.map(bot=>[bot.id,bot.name]));
}

export function MemoryEditor({workspace,item,source,onClose,onSaved}) {
  const dialog=useRef();
  const bodyId=useId();
  const [title,setTitle]=useState(item?.title??source?.text.trim().split('\n')[0].slice(0,60)??'');
  const [content,setContent]=useState(item?.content??source?.text.slice(0,800)??'');
  const [bots,setBots]=useState(item?.bots??[]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const names=botNames(workspace);
  const selectable=[...names].filter(([id])=>workspace.installedBots.includes(id)||bots.includes(id));
  useEffect(()=>{dialog.current.showModal();},[]);
  function close() {
    if (busy) return;
    dialog.current.close();
    onClose();
  }
  async function submit(event) {
    event.preventDefault();
    if(busy||!title.trim()||!content.trim())return;
    setBusy(true);setError('');
    try {
      await api(item?'/memories/'+item.id:'/memories',{title,content,bots,confirmed:true,
        ...(item?{revision:item.revision}:source?{source:{room:source.room,run:source.run}}:{})});
      dialog.current.close();
      onSaved();
    } catch(error) {setError(error.message);setBusy(false);}
  }
  return <dialog ref={dialog} className="modal memory-dialog" aria-labelledby="memory-dialog-title"
    onCancel={event=>{event.preventDefault();close();}}>
    <header className="modal-head"><h2 id="memory-dialog-title">{item?'编辑工作区记忆':'保存为工作区记忆'}</h2>
      <button className="icon-button" type="button" aria-label="关闭记忆编辑" onClick={close}><X size={19}/></button></header>
    <p className="muted">保存到「{workspace.workspace.name}」。同组会话启用后，这段文字可随任务发送给模型。</p>
    <form onSubmit={submit}>
      <label>标题<input required maxLength={60} value={title} onChange={event=>setTitle(event.target.value)}/></label>
      <div className="memory-field"><label htmlFor={bodyId}>记忆正文</label>
        <textarea id={bodyId} required rows={5} maxLength={800} value={content} onChange={event=>setContent(event.target.value)}/></div>
      {source?.text.length>800&&<p className="muted">已带入原消息的前 800 字，保存前可编辑。</p>}
      {selectable.length>0&&<fieldset className="memory-scope"><legend>适用 Bot</legend>
        {selectable.map(([id,name])=><label key={id}><input type="checkbox" checked={bots.includes(id)}
          onChange={event=>setBots(event.target.checked?[...bots,id]:bots.filter(value=>value!==id))}/>{name}</label>)}
        <p className="muted">留空时适用这个工作区里的所有 Bot。</p>
      </fieldset>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={busy||!title.trim()||!content.trim()}>{busy?'正在保存…':'确认保存'}</button></div>
    </form>
  </dialog>;
}

export function WorkspaceMemory({workspace,online,notify}) {
  const [items,setItems]=useState(null);
  const [editor,setEditor]=useState(null);
  const [confirm,setConfirm]=useState(null);
  const [revoking,setRevoking]=useState(false);
  const [error,setError]=useState('');
  const [reload,setReload]=useState(0);
  const names=botNames(workspace);
  useEffect(()=>{
    const controller=new AbortController();
    api('/memories',undefined,{signal:controller.signal}).then(setItems).catch(error=>{
      if(error.name!=='AbortError')setError(error.message);
    });
    return ()=>controller.abort();
  },[reload]);
  function refresh() {setError('');setReload(value=>value+1);}
  async function revoke(item) {
    if(revoking||!online)return;
    setRevoking(true);setError('');
    try {
      await api('/memories/'+item.id+'/revoke',{revision:item.revision,confirmed:true});
      setConfirm(null);
      notify('已撤回工作区记忆。');
      refresh();
    } catch(error) {setError(error.message);}
    finally {setRevoking(false);}
  }
  return <>
    <div className="section-head"><div><h1>工作区记忆</h1><p>{workspace.workspace.name}</p></div>
      <button className="button primary" type="button" disabled={!online} onClick={()=>setEditor({})}><Plus size={17}/>新建记忆</button></div>
    {error&&<p className="form-error" role="alert">{error} <button className="text-button" onClick={refresh}>刷新</button></p>}
    {!items&&!error&&<p className="muted" role="status">正在读取记忆…</p>}
    {items?.length===0&&<div className="empty-page"><BookOpen size={22}/><h2>还没有共享记忆</h2>
      <p>可以保存本组常用的术语、项目背景或创作偏好。</p></div>}
    <div className="memory-list">
      {items?.map(item=>{
        const source=item.source&&workspace.conversations.find(room=>room.id===item.source.room);
        return <article className="memory-entry" key={item.id}>
          <header><h2>{item.title}</h2><span className="version">v{item.revision}</span></header>
          <p>{item.content}</p>
          <div className="memory-meta"><span>{item.author}</span><span>{item.bots.length?item.bots.map(bot=>names.get(bot)??bot).join('、'):'本组全部 Bot'}</span>
            {source&&<a href={runHref({id:item.source.run,conversation:source.id})}>来源 · {source.title}</a>}</div>
          <div className="memory-actions">
            {confirm===item.id?<><span>撤回后，新任务不会再收到这条记忆。</span>
              <button type="button" className="button compact" disabled={revoking} onClick={()=>setConfirm(null)}>取消</button>
              <button type="button" className="button compact danger" disabled={revoking||!online} onClick={()=>void revoke(item)}>确认撤回</button></>
            :<><button type="button" className="text-button" disabled={!online} onClick={()=>setEditor(item)}><Pencil size={15}/>编辑</button>
              <button type="button" className="text-button" disabled={!online} onClick={()=>setConfirm(item.id)}><Trash2 size={15}/>撤回</button></>}
          </div>
        </article>;
      })}
    </div>
    {editor&&<MemoryEditor workspace={workspace} item={editor.id?editor:null} onClose={()=>setEditor(null)} onSaved={()=>{
      setEditor(null);notify('已保存工作区记忆。');refresh();
    }}/>}
  </>;
}

export function MemoryReceipt({room,runId}) {
  const run=runId?room.runs.find(item=>item.id===runId):room.runs.at(-1);
  const receipt=run?.memoryReceipt;
  return <section className="preview-memory">
    <h3 className="panel-title">本轮记忆回执</h3>
    {receipt?.length?<><p className="muted">本轮模型请求包含以下记忆版本。</p>
      <ul>{receipt.map(item=><li key={item.id}><Link2 size={15}/><strong>{item.title}</strong><span className="version">v{item.revision}</span></li>)}</ul></>
      :<p className="muted">{room.useWorkspaceMemory?'本轮没有发送工作区记忆。':'此会话仅用本会话内容。'}</p>}
    <a className="text-button" href="#memory">管理工作区记忆</a>
  </section>;
}
