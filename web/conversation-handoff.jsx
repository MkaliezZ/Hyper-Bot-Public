import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, GitBranch, X } from 'lucide-react';
import { api } from './client.js';

export function ConversationHandoff({room,target,online,onClose,onCreated}) {
  const modal=useRef(),titleInput=useRef(),timer=useRef(),request=useRef();
  const [title,setTitle]=useState(()=>room.title.slice(0,96)+'（续接）');
  const [selected,setSelected]=useState([]);
  const [saving,setSaving]=useState(false);
  const [closing,setClosing]=useState(false);
  const [error,setError]=useState('');
  const files=room.materials.filter(file=>!file.endedAt);
  const materials=files.filter(file=>selected.includes(file.id)).map(file=>file.id);

  useEffect(()=>{
    const node=modal.current;
    node.showModal();
    titleInput.current?.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if (node.open) node.close();};
  },[]);

  function close() {
    if (closing||saving) return;
    const finish=()=>{modal.current?.close();onClose();};
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else {setClosing(true);timer.current=setTimeout(finish,120);}
  }

  async function create(event) {
    event.preventDefault();
    if (saving||closing||!online||!title.trim()||!materials.length) return;
    const signature=JSON.stringify([target.revision,title.trim(),materials]);
    if (request.current?.signature!==signature) request.current={signature,id:crypto.randomUUID()};
    setSaving(true);
    setError('');
    try {
      const {id}=await api('/rooms',{
        botId:target.id,revision:target.revision,title:title.trim(),
        handoff:{from:room.id,materials,authorized:true,requestId:request.current.id}
      },{signal:AbortSignal.timeout(45000)});
      if (modal.current?.open) onCreated(id);
    } catch (problem) {
      setError(problem.message);
      setSaving(false);
    }
  }

  return <dialog ref={modal} className={'modal handoff-dialog'+(closing?' closing':'')}
    aria-labelledby="handoff-title" onCancel={event=>{event.preventDefault();close();}}>
    <div className="modal-head"><h2 id="handoff-title">切换版本续接</h2>
      <button type="button" className="icon-button" aria-label="关闭续接" disabled={saving} onClick={close}><X size={19}/></button></div>
    <form onSubmit={create}>
      <div className="handoff-versions"><GitBranch size={16}/><strong>{target.name}</strong>
        <span>r{room.revision}</span><ArrowRight size={15}/><span>r{target.revision}</span></div>
      {room.project&&<p className="handoff-project">沿用项目 <strong>{room.projectTitle||room.title}</strong></p>}
      <label>新会话标题<input ref={titleInput} maxLength={100} value={title} disabled={saving}
        onChange={event=>setTitle(event.target.value)}/></label>
      <fieldset className="handoff-materials" aria-describedby="handoff-scope" disabled={saving}>
        <legend>选用已授权材料</legend>
        <p id="handoff-scope" className="muted">每次最多选 6 份。到期和撤回会同步作用于已选用该材料的会话。</p>
        {files.length===0&&<p className="muted">此会话已无可续接的材料。</p>}
        <div className="handoff-files">{files.map(file=><label key={file.id}>
          <input type="checkbox" checked={materials.includes(file.id)}
            disabled={materials.length>=6&&!materials.includes(file.id)}
            onChange={event=>setSelected(event.target.checked?[...selected,file.id]:selected.filter(id=>id!==file.id))}/>
          <span>{file.name}{file.expiresAt&&<small>有效至 {new Date(file.expiresAt).toLocaleString('zh-CN',{hour12:false})}</small>}</span>
        </label>)}</div>
      </fieldset>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={close} disabled={saving}>取消</button>
        <button type="submit" className="button primary" disabled={saving||!online||!materials.length||!title.trim()}>
          {saving?'正在建立会话…':'授权并新建会话'}<ArrowRight size={16}/></button>
      </div>
    </form>
  </dialog>;
}
