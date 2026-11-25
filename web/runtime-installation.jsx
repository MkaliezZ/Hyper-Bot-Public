import React, { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';

function RuntimeDialog({id,label,check,online,refresh,notify,onClose}) {
  const dialog=useRef(null), first=useRef(null), cancel=useRef(null), timer=useRef(null);
  const focusedAction=useRef(null), submit=useRef(null);
  const title=useId(),help=useId();
  const [session,setSession]=useState(null),[action,setAction]=useState(''),[confirmReset,setConfirmReset]=useState(false);
  const [leaving,setLeaving]=useState(false),[error,setError]=useState('');
  const busy=!!action;

  useEffect(()=>{
    const node=dialog.current;
    const runtime=window.hyperBot.runtimeSetup;
    let alive=true,ticket;
    node.showModal();
    cancel.current?.focus({preventScroll:true});
    runtime.begin(id).then(result=>{
      ticket=result.ticket;
      if (alive) setSession(result);
      else void runtime.close(ticket).catch(()=>{});
    }).catch(()=>{if(alive)setError('暂时无法打开本机组件设置。');});
    return ()=>{
      alive=false;
      clearTimeout(timer.current);
      if(ticket)void runtime.close(ticket).catch(()=>{});
      if(node.open)node.close();
    };
  },[id]);

  useEffect(()=>{
    if (session?.ticket) (confirmReset?cancel.current:first.current)?.focus({preventScroll:true});
  },[session?.ticket,confirmReset]);

  useEffect(()=>{
    if (!busy && !leaving && focusedAction.current) {
      focusedAction.current.focus({preventScroll:true});
      focusedAction.current=null;
    }
  },[busy,leaving]);

  function close() {
    if (leaving) return;
    const finish=()=>{dialog.current?.close();onClose();};
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else {setLeaving(true);timer.current=setTimeout(finish,120);}
  }

  async function pick(field,opener) {
    if (!session || busy || !online) return;
    focusedAction.current=opener;
    setAction(field);setError('');
    try {
      const fields=await window.hyperBot.runtimeSetup.pick(session.ticket,field);
      setSession({...session,fields});
    } catch {setError('暂时无法打开文件选择。');}
    finally {setAction('');}
  }

  async function apply(mode) {
    if (!session || busy || !online) return;
    focusedAction.current=submit.current;
    setAction('apply');setError('');
    try {
      const result=await window.hyperBot.runtimeSetup.apply(session.ticket,mode);
      if (!result.ok && !result.saved) {setError(result.message);return;}
      const refreshed=await refresh();
      notify(!result.ok?result.message:!refreshed?'设置已保存。重连后可核对本机依赖。':
        mode==='automatic'?'已恢复自动查找。':'本机组件设置已保存。');
      close();
    } catch {setError('本机服务连接中断。请检查组件状态后重试。');}
    finally {setAction('');}
  }

  return <dialog ref={dialog} className={'modal runtime-dialog'+(leaving?' closing':'')} aria-labelledby={title} aria-describedby={help}
    onCancel={event=>{event.preventDefault();if(!busy)close();}}>
    <header className="modal-head"><h2 id={title}>配置 {label}</h2>
      <button type="button" className="icon-button" aria-label="关闭组件设置" disabled={busy} onClick={close}><X size={19}/></button>
    </header>
    <form onSubmit={event=>{event.preventDefault();void apply(confirmReset?'automatic':'selected');}}>
      {confirmReset
        ?<p id={help}>此工作区将按启动环境与本机安装记录查找 {label}。</p>
        :<>
          <p id={help} className="muted">检查锁定版本和 Python 模块后，本机服务会在原窗口重连。</p>
          <div className="runtime-fields">
            <div><span className="runtime-field-label" id={help+'-root'}>安装目录</span>
              <span className="runtime-selected" aria-live="polite">{session?.fields.root??'未选择'}</span>
              <button ref={first} type="button" className="button" disabled={!session||busy||!online}
                aria-describedby={help+'-root'} onClick={event=>void pick('root',event.currentTarget)}>选择目录</button>
            </div>
            <div><span className="runtime-field-label" id={help+'-python'}>Python</span>
              <span className="runtime-selected" aria-live="polite">{session?.fields.python??'未选择'}</span>
              <button type="button" className="button" disabled={!session||busy||!online}
                aria-describedby={help+'-python'} onClick={event=>void pick('python',event.currentTarget)}>选择 Python</button>
            </div>
          </div>
          {check.source==='desktop'&&<button type="button" className="text-button runtime-reset"
            disabled={busy||!session||!online} onClick={()=>{setError('');setConfirmReset(true);}}>恢复自动查找</button>}
        </>}
      {error&&<p role="alert" className="form-error">{error}</p>}
      <div className="modal-actions">
        <button ref={cancel} type="button" className="button" disabled={busy} onClick={confirmReset?()=>setConfirmReset(false):close}>
          {confirmReset?'返回':'取消'}</button>
        <button ref={submit} type="submit" className="button primary" disabled={busy||leaving||!online||!session||
          (!confirmReset&&(!session.fields.root||!session.fields.python))}>
          {action==='apply'?'正在检查并接入…':confirmReset?'确认恢复':'检查并保存'}</button>
      </div>
    </form>
  </dialog>;
}

export function RuntimeInstallation({id,label,check,available,online,busy,refresh,notify}) {
  const [open,setOpen]=useState(false),opener=useRef(null);
  if (!available || !window.hyperBot?.runtimeSetup) return null;
  return <>
    {check.source==='desktop'&&<p className="dependency-meta">已在本工作区登记</p>}
    <div className="manage-actions runtime-actions">
      <button ref={opener} className="button" type="button" disabled={busy||!online}
        onClick={()=>setOpen(true)}><FolderOpen size={16}/>配置安装</button>
    </div>
    {open&&<RuntimeDialog id={id} label={label} check={check} online={online} refresh={refresh} notify={notify}
      onClose={()=>{setOpen(false);opener.current?.focus({preventScroll:true});}}/>}
  </>;
}
