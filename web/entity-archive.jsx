import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import { api, artifactHref, runHref } from './client.js';

function useEntity(route,version) {
  const [state,setState]=useState(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    api(route,undefined,{signal:controller.signal}).then(data=>{
      if (!controller.signal.aborted) setState({route,data});
    }).catch(error=>{
      if (!controller.signal.aborted) setState({route,error:error.message});
    });
    return ()=>controller.abort();
  },[route,version,retry]);
  const active=state?.route===route?state:{};
  return {...active,retry:()=>{setState(null);setRetry(n=>n+1);}};
}

function LoadState({request}) {
  return request.error?<p className="form-error" role="alert">{request.error}
    {' '}<button className="text-button" type="button" onClick={request.retry}>重试</button></p>
    :<p className="muted" role="status">正在读取档案…</p>;
}

function SourceLinks({source,onOpen}) {
  return <div className="memory-meta">
    <a href={artifactHref({id:source.artifact,conversation:source.room})} onClick={onOpen}>查看分镜版本</a>
    <a href={runHref({id:source.run,conversation:source.room})} onClick={onOpen}>查看原任务</a>
    {source.confirmedAt&&<time dateTime={source.confirmedAt}>确认于 {new Date(source.confirmedAt).toLocaleString('zh-CN',{
      dateStyle:'short',timeStyle:'short'
    })}</time>}
    {source.materials.map(material=><a key={material.id} onClick={onOpen}
      href={'#chat/'+source.room+'?material='+material.id}>{material.name} · 第 {material.line} 行</a>)}
  </div>;
}

function ArchiveConfirmation({item,online,onSaved,onCancel}) {
  const [form,setForm]=useState(item.options[0].value);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function save(event) {
    event.preventDefault();
    if (!online||busy) return;
    setBusy(true);setError('');
    try {
      const record=await api('/entity/records',{artifact:item.artifact,form,confirmed:true});
      onSaved(record);
    } catch(error) {setError(error.message);}
    finally {setBusy(false);}
  }
  return <form className="entity-flow" onSubmit={save}>
    <p className="muted">存入 {item.owner}</p>
    <fieldset className="entity-options" disabled={busy||!!item.existing}>
      <legend>记录内容</legend>
      {item.options.map(option=><label key={option.value}>
        <input type="radio" name="entity-form" checked={form===option.value} onChange={()=>setForm(option.value)}/>
        <span>{option.label}</span>
      </label>)}
    </fieldset>
    <SourceLinks source={{...item,materials:item.sources}} onOpen={onCancel}/>
    {!item.attributed&&<p className="muted">此历史任务请由本人确认归属。</p>}
    <p className="muted">依据范围包括分镜版本和写入确认。创作分工可另补证。</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {item.existing?<a className="text-button" href={'#entity/'+item.existing.claim_id}>查看已存档记录</a>
      :<div className="memory-actions">
        <button type="button" className="button compact" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="button primary compact" disabled={!online||busy}>确认入档</button>
      </div>}
  </form>;
}

export function EntityPanel({mode,version,online,onChange,onChoose,onSaved,onClose}) {
  const route=mode.kind==='archive'?'/entity/candidates/'+mode.artifact:mode.kind==='source'?'/entity/sources':'/entity';
  const request=useEntity(route,version);
  const title=useRef();
  useEffect(()=>{title.current?.focus({preventScroll:true});},[route]);
  return <section className="entity-flow">
    <h3 className="panel-title" tabIndex={-1} ref={title}>{mode.kind==='archive'?'存入档案':
      mode.kind==='source'?'选择已保存的分镜':'引用档案'}</h3>
    {!request.data?<LoadState request={request}/>
      :mode.kind==='archive'?<ArchiveConfirmation item={request.data} key={mode.artifact} online={online}
        onSaved={onSaved} onCancel={onClose}/>
      :mode.kind==='source'?<>
        {request.data.length===0&&<p className="muted">保存一版口播分镜后，可从这里入档。</p>}
        {request.data.map(source=><button className="button" key={source.id} type="button"
          onClick={()=>onChange({kind:'archive',artifact:source.id})}>{source.title}</button>)}
      </>:<>
        {request.data.records.length===0&&<p className="muted">还没有档案记录。可从已保存的口播成果入档。</p>}
        {request.data.records.some(record=>!record.reason)&&<p className="muted">所选摘要会随本轮任务发送给当前模型。</p>}
        {request.data.records.map(record=><article className="memory-entry" key={record.ref.claim_id}>
          <h4>{record.title}</h4>
          <p>{record.reason||record.statement}</p>
          {!record.reason&&<div className="memory-actions">
            <button className="button compact" type="button" disabled={!online} onClick={()=>onChoose(record)}>
              引用这条 · v{record.ref.version}</button>
          </div>}
        </article>)}
      </>}
  </section>;
}

export function EntityArchive({version,selected,online,notify,refresh}) {
  const [mode,setMode]=useState(null);
  const [confirmation,setConfirmation]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const request=useEntity('/entity',version);
  const target=useRef();
  useEffect(()=>{
    if(selected&&target.current) target.current.scrollIntoView({block:'nearest',behavior:'instant'});
  },[selected,request.data]);
  function changed(text) {
    notify(text);
    request.retry();
    void refresh();
  }
  async function revoke(record) {
    if (!online||busy) return;
    setBusy(true);setError('');
    try {
      await api('/entity/records/'+record.ref.claim_id+'/revoke',{version:record.ref.version,confirmed:true});
      setConfirmation(null);changed('已撤回复用许可。');
    } catch(error) {setError(error.message);}
    finally {setBusy(false);}
  }
  return <>
    <div className="section-head"><div><h1>档案</h1><p>本人 · 此设备</p></div>
      <button className="button primary" type="button" disabled={!online} onClick={()=>setMode({kind:'source'})}>
        <Plus size={17}/>从口播成果新增</button></div>
    {mode&&<div className="memory-list">
      <EntityPanel key={mode.kind} mode={mode} version={version} online={online}
        onChange={setMode} onClose={()=>setMode(null)}
        onSaved={()=>{setMode(null);changed('已存入档案。');}}/>
      {mode.kind==='source'&&<button type="button" className="text-button" onClick={()=>setMode(null)}>返回档案</button>}
    </div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!request.data?<LoadState request={request}/>
      :request.data.records.length===0&&!mode?<div className="empty-page">
        <BookOpen size={22}/><h2>还没有档案记录</h2><p>可以从已保存的口播分镜登记一条有依据的经历。</p>
      </div>:<div className="memory-list">
        {request.data.records.map(record=><article className="memory-entry" key={record.ref.claim_id}
          ref={record.ref.claim_id===selected?target:null}>
          <header><h2>{record.title}</h2><span className="version">档案 v{record.ref.version}</span></header>
          <p>{record.reason||record.statement}</p>
          {record.source&&<SourceLinks source={record.source}/>}
          {!record.revoked&&<div className="memory-actions">
            {confirmation===record.ref.claim_id?<><span>撤回后，新任务不能再引用这条记录。</span>
              <button className="button compact" type="button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button>
              <button className="button compact danger" type="button" disabled={!online||busy}
                onClick={()=>void revoke(record)}>确认撤回</button></>
              :<button className="text-button" type="button" disabled={!online}
                onClick={()=>setConfirmation(record.ref.claim_id)}>撤回复用许可</button>}
          </div>}
        </article>)}
      </div>}
  </>;
}
