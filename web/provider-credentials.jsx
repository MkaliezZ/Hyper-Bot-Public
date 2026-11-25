import React, { useEffect, useId, useRef, useState } from 'react';
import { KeyRound, X } from 'lucide-react';

function CredentialDialog({intent,check,online,onClose,refresh,notify}) {
  const dialog=useRef(null), input=useRef(null), cancel=useRef(null), timer=useRef(null);
  const title=useId(), details=useId();
  const [saving,setSaving]=useState(false),[leaving,setLeaving]=useState(false),[error,setError]=useState('');
  const clearing=intent==='clear';
  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    (input.current??cancel.current)?.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);
  useEffect(()=>{
    if(error) (input.current??cancel.current)?.focus({preventScroll:true});
  },[error]);

  function close() {
    if (leaving) return;
    const finish=()=>{dialog.current?.close();onClose();};
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else {setLeaving(true);timer.current=setTimeout(finish,120);}
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || leaving || !online) return;
    const value=clearing?null:input.current.value;
    if (input.current) input.current.value='';
    setSaving(true);setError('');
    try {
      const result=await window.hyperBot.setProviderCredential(value);
      if (!result.ok) {setError(result.message);return;}
      const updated=await refresh();
      notify(!updated?'凭据已更新。服务重连后可核对状态。':clearing?'已清除本机凭据。':'模型凭据已保存。');
      close();
    } catch {
      setError('本机服务暂时无法更新凭据。请重试。');
    } finally {setSaving(false);}
  }

  return <dialog className={'modal credential-dialog'+(leaving?' closing':'')} ref={dialog}
    aria-labelledby={title} aria-describedby={details} onCancel={event=>{event.preventDefault();if(!saving)close();}}>
    <header className="modal-head"><h2 id={title}>
      {clearing?'清除本机凭据':check.source==='desktop'?'更换 DeepSeek 凭据':'配置 DeepSeek 凭据'}</h2>
      <button type="button" className="icon-button" aria-label="关闭凭据设置" disabled={saving}
        onClick={close}><X size={19}/></button></header>
    <form onSubmit={submit}>
      {!clearing&&<label>DeepSeek API Key<input type="password" ref={input} required autoComplete="off"
        spellCheck={false} maxLength={1024} disabled={saving} aria-describedby={details}/></label>}
      <p id={details} className="muted">{clearing
        ?check.environmentFallback?'清除后，本工作区使用启动环境中的凭据。':'清除后，依赖模型的 Bot 将暂停接收任务。已保存的成果仍可查看。'
        :<>{check.source==='environment'?'保存后优先使用本机凭据。':'Windows 会为本工作区加密保存凭据。'}
          <span className="credential-hint">发起任务时检查模型连通性。</span></>}</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" ref={cancel} disabled={saving} onClick={close}>取消</button>
        <button type="submit" className={'button '+(clearing?'danger':'primary')} disabled={saving||leaving||!online}>
          {saving?'正在处理…':clearing?'确认清除':'加密保存'}</button>
      </div>
    </form>
  </dialog>;
}

export function ProviderCredential({check,online,busy,refresh,notify}) {
  const [selection,setSelection]=useState(null), opener=useRef(null);
  const controls=!!window.hyperBot?.setProviderCredential&&check.canStore;
  const configure=(intent,event)=>{opener.current=event.currentTarget;setSelection({intent,check});};
  return <>
    {check.source&&<p className="dependency-meta">
      {check.source==='desktop'?'本工作区已加密保存':check.source==='environment'?'来自启动环境':'在当前会话已配置'}
    </p>}
    {check.local==='unreadable'&&<p className="credential-issue" role="status">
      本机凭据无法读取。{controls&&'可更换或清除。'}</p>}
    {controls?<div className="manage-actions credential-actions">
      <button type="button" className="button" disabled={busy||!online} onClick={e=>configure('save',e)}>
        <KeyRound size={16}/>{check.local==='missing'?'配置凭据':'更换凭据'}
      </button>
      {check.local!=='missing'&&<button type="button" className="button" disabled={busy||!online}
        onClick={e=>configure('clear',e)}>清除本机凭据</button>}
    </div>:!check.ok&&<p>在启动环境中设置 <code>DEEPSEEK_API_KEY</code> 后重启 Hyper Bot。</p>}
    {selection&&<CredentialDialog {...selection} online={online} refresh={refresh} notify={notify}
      onClose={()=>{
        setSelection(null);
        const target=opener.current?.isConnected?opener.current:document.getElementById('dependency-provider');
        target?.focus({preventScroll:true});
      }}/>}
  </>;
}

