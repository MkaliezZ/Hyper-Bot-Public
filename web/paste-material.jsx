import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function PasteMaterial({materials,online,onAdd,onClose}) {
  const dialog=useRef();
  const timer=useRef();
  const original=useRef();
  const [name,setName]=useState(()=>{
    const names=new Set(materials.map(file=>file.name));
    let number=1;
    while (names.has('粘贴材料 '+number+'.txt')) number++;
    return '粘贴材料 '+number;
  });
  const [text,setText]=useState('');
  const [saving,setSaving]=useState(false);
  const [closing,setClosing]=useState(false);
  const [error,setError]=useState('');

  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    original.current.focus({preventScroll:true});
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);

  function close() {
    if(closing)return;
    const finish=()=>{dialog.current.close();onClose();};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)finish();
    else {setClosing(true);timer.current=setTimeout(finish,120);}
  }

  async function submit() {
    if(saving||closing||!online)return;
    const title=name.trim();
    const content=text.trim();
    if(!title||/[\\/:*?"<>|\u0000-\u001f]/u.test(title)) {
      setError('请填写有效的材料名称，名称不能包含路径符号。');
      return;
    }
    if(content.includes('\0')||new TextEncoder().encode(content).byteLength>64000) {
      setError('请选择有效的纯文字，每份最多 64 KB。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const filename=/\.(?:txt|md)$/i.test(title)?title:title+'.txt';
      await onAdd({name:filename,content});
      close();
    } catch(problem) {
      setError(problem.message);
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialog} className={'modal paste-material'+(closing?' closing':'')} aria-labelledby="paste-material-title"
    onCancel={event=>{event.preventDefault();if(!saving)close();}}>
    <header className="modal-head"><h2 id="paste-material-title">粘贴文字材料</h2>
      <button type="button" className="icon-button" aria-label="关闭粘贴文字" disabled={saving||closing} onClick={close}><X size={19}/></button>
    </header>
    <form aria-busy={saving} onSubmit={event=>{event.preventDefault();void submit();}}>
      <label>材料名称<input value={name} maxLength={176} disabled={saving||closing}
        onChange={event=>{setName(event.target.value);setError('');}}/></label>
      <label>原文<textarea ref={original} value={text} rows={6} maxLength={64000} aria-describedby="paste-material-hint"
        placeholder="粘贴采访、笔记或其他文字" disabled={saving||closing}
        onChange={event=>{setText(event.target.value);setError('');}}/></label>
      <p id="paste-material-hint" className="muted">添加后，当前会话可使用这段原文。每份最多 64 KB。</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" disabled={saving||closing} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={!online||saving||closing||!name.trim()||!text.trim()}>
          {saving?'正在添加…':'授权并添加'}</button>
      </div>
    </form>
  </dialog>;
}
