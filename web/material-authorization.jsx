import React, { useEffect, useRef, useState } from 'react';
import { ShieldOff, X } from 'lucide-react';
import { api } from './client.js';

function localDate(stamp) {
  if (!stamp) return '';
  const date=new Date(stamp);
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}

export function MaterialAuthorization({roomId,file,onClose,onSaved,original}) {
  const dialog=useRef();
  const timer=useRef();
  const [deadline,setDeadline]=useState(()=>localDate(file.expiresAt));
  const [confirming,setConfirming]=useState(false);
  const [saving,setSaving]=useState(false);
  const [leaving,setLeaving]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    return ()=>{clearTimeout(timer.current);if (node.open) node.close();};
  },[]);

  function close() {
    if (leaving) return;
    const finish=()=>{dialog.current.close();onClose();};
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else {setLeaving(true);timer.current=setTimeout(finish,120);}
  }

  async function submit(revoke) {
    if (saving || leaving) return;
    setSaving(true);
    setError('');
    try {
      const route='/rooms/'+roomId+'/materials/'+file.id;
      if (revoke) await api(route+'/revoke',{confirmed:true});
      else await api(route+'/deadline',{expiresAt:deadline?new Date(deadline).toISOString():null});
      close();
      await onSaved(revoke?'材料授权已撤回。':'授权期限已保存。');
    } catch(error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialog} className={'modal material-modal'+(leaving?' closing':'')} aria-labelledby="material-authority"
    onCancel={event=>{event.preventDefault();if (!saving) close();}} onKeyDown={event=>event.stopPropagation()}>
    <header className="modal-head"><h2 id="material-authority">{confirming?'撤回材料授权':'材料授权'}</h2>
      <button type="button" className="icon-button" aria-label="关闭材料授权" disabled={saving} onClick={close}><X size={19}/></button>
    </header>
    <p className="material-name">{file.name}</p>
    {confirming ? <div className="material-dialog-content">
      <p>Hyper Bot 会清理本地原文副本、关联稿件和草稿，保留版本及任务状态。{file.shared?'撤回作用于已选用该材料的所有会话。':''}{original?'独立工作台内的原文和已确认写入的稿件由原项目管理。':''}另存文件和早期备份需单独处理。</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button" onClick={()=>{setConfirming(false);setError('');}} disabled={saving}>返回</button>
        <button type="button" className="button danger" disabled={saving} onClick={()=>void submit(true)}><ShieldOff size={16}/>确认撤回</button></div>
    </div> : <form onSubmit={event=>{event.preventDefault();void submit(false);}}>
      <label><span>到期时间 <small className="muted">按本机时间</small></span><input autoFocus type="datetime-local" value={deadline}
        onChange={event=>setDeadline(event.target.value)} disabled={saving}/></label>
      <p className="muted">留空表示持续授权。到期时自动清理原文、关联稿件和草稿。{file.shared?'期限适用于已选用该材料的所有会话。':''}</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="text-button material-revoke" disabled={saving}
        onClick={()=>{setConfirming(true);setError('');}}>撤回授权…</button>
        <div><button type="button" className="text-button" aria-label="清空到期时间" disabled={!deadline||saving} onClick={()=>setDeadline('')}>清空</button>
          <button type="submit" className="button primary" disabled={saving}>保存期限</button></div></div>
    </form>}
  </dialog>;
}

