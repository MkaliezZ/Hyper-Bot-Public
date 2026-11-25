import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, RefreshCw, X } from 'lucide-react';
import { api, day } from './client.js';

export function OriginalProject({room,attachments,onAttach,onBase,onClose}) {
  const dialog=useRef();
  const timer=useRef();
  const [state,setState]=useState(null);
  const [error,setError]=useState('');
  const [working,setWorking]=useState('');
  const [leaving,setLeaving]=useState(false);
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    setError('');
    api('/rooms/'+room.id+'/original',undefined,{signal:controller.signal})
      .then(setState)
      .catch(error=>{if (error.name!=='AbortError')setError(error.message);});
    return ()=>controller.abort();
  },[room.id,reload]);
  function close() {
    if(working || leaving)return;
    const finish=()=>{dialog.current.close();onClose();};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setLeaving(true);timer.current=setTimeout(finish,120);}
  }
  async function select(file) {
    setWorking(file.id);
    setError('');
    try {await onAttach(file);}
    catch(error) {setError(error.message);}
    finally {setWorking('');}
  }
  function useBase() {
    onBase(state.latest.id);
    close();
  }
  return <dialog ref={dialog} className={'modal original-dialog'+(leaving?' closing':'')} aria-labelledby="original-project-title"
    onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
    <header className="modal-head"><div><h2 id="original-project-title">原工作台项目</h2>
      <p className="muted">{room.projectTitle}</p></div>
      <button type="button" className="icon-button" aria-label="关闭原工作台项目" disabled={!!working} onClick={close}><X size={19}/></button>
    </header>
    <div className="original-dialog-body">
      {error&&<div className="original-dialog-error"><p role="alert" className="form-error">{error}</p>
        <button type="button" className="text-button" onClick={()=>{setState(null);setReload(reload+1);}}><RefreshCw size={15}/>重新读取</button></div>}
      {!state&&!error&&<p className="muted" role="status">正在读取原项目…</p>}
      {state&&<>
        {state.latest&&<section className="original-current"><div><h3>当前分镜</h3>
          <p className="muted">{state.latest.segments} 镜 · {day(state.latest.createdAt)} · 修订 r{state.revision}</p>
          <p className="muted">续稿时请同时选用原稿引用的材料。</p></div>
          <button type="button" className="button compact" disabled={!!working} onClick={useBase}><BookOpen size={15}/>带入原稿</button></section>}
        <section aria-label="项目文字素材"><h3>项目文字素材</h3>
          <p className="muted">选用的原文会作为本轮授权材料。</p>
          <div className="original-source-list">{state.sources.map(file=>{
            const included=room.materials.some(item=>!item.endedAt&&item.originalSource?.id===file.id&&
              item.originalSource.digest===file.digest&&attachments.includes(item.id));
            return <div className="original-source-row" key={file.id}><FileText size={17}/>
              <div className="original-source-name"><span>{file.name}</span>
                {state.latest?.sourceIds.includes(file.id)&&<span className="muted">原稿引用</span>}</div>
              <button type="button" className="button compact" aria-label={'选用 '+file.name}
                disabled={!!working||included||attachments.length>=6} onClick={()=>void select(file)}>
                {included?'已选用':working===file.id?'读取中…':'选用'}</button></div>;
          })}</div>
          {!state.sources.length&&<p className="muted">当前没有可选文字，可在聊天输入框添加 TXT 或 Markdown。</p>}
        </section>
      </>}
    </div>
  </dialog>;
}

