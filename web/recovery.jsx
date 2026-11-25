import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Clock3, FileText, History, MessageSquare } from 'lucide-react';
import { api, artifactHref, clock, day, runHref } from './client.js';

const stateLabel={pending:'写入待核对',saved:'已核对保存回执',not_saved:'分镜未保存'};
const stateStyle={pending:'wait',saved:'success',not_saved:''};
const shortId=row=>row.id.slice(0,8);

function RecoveryStatus({state}) {
  return <span className={'chip '+stateStyle[state]}>{stateLabel[state]}</span>;
}

function Fields({items}) {
  return <dl className="recovery-fields">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Receipt({row,owner,checking,online,onCheck}) {
  const pending=row.state==='pending', saved=row.state==='saved';
  const detail=pending
    ? row.checkedAt?'未读到匹配回执。原项目的写入仍待核对。':'写入开始后未收到确认。按原任务编号只读查询原项目回执。'
    : saved?'原项目回执与这轮任务的提交一致。':Number.isInteger(row.registered)
      ? '原项目已确认这轮分镜未保存，登记材料 '+row.registered+' 份。':'原项目已确认这轮分镜未保存。';
  const stamp=row.checkedAt&&<time dateTime={row.checkedAt}>{day(row.checkedAt)} {clock(row.checkedAt)}</time>;
  const title=pending?'核对这版稿件是否已保存':saved?'已找回这版分镜稿':'已确认分镜未保存';
  return <div className="recovery-grid">
    <section className="recovery-card receipt-card" aria-labelledby="receipt-title">
      <div className="recovery-label"><History size={15}/>原项目回读</div>
      <h2 id="receipt-title">{title}</h2>
      <div role="status" className={'receipt-status '+stateStyle[row.state]}>
        <div className="status-in" key={row.state+row.checkedAt}>
          {saved?<Check size={18}/>:<Clock3 size={18}/>}
          <div><strong>{stateLabel[row.state]}</strong><p>{detail}</p></div>
        </div>
      </div>
      <Fields items={[
        ['原项目',row.projectTitle],
        ['所属会话',row.roomTitle],
        ['本次提交',<span className="version-id">{shortId(row)}{row.artifact?' / v'+row.artifact.version:''}</span>],
        ...(stamp?[['最近核对',stamp]]:[])
      ]}/>
      <div className="recovery-actions">
        {pending&&<button type="button" className="button primary" disabled={!online||checking} onClick={()=>onCheck(row)}>
          <History size={17}/>{checking?'正在核对…':'只读核对原项目'}
        </button>}
        {row.artifact&&<a className="button primary" href={artifactHref(row.artifact)}><FileText size={17}/>打开稿件 v{row.artifact.version}</a>}
        <a className="button" href={runHref(row)}><MessageSquare size={16}/>返回会话</a>
      </div>
    </section>
    <div className="recovery-ownership">
      <section className="recovery-card" aria-labelledby="recovery-owner">
        <h2 id="recovery-owner">任务归属</h2>
        <Fields items={[
          ['项目',<>{row.projectTitle}{row.original&&<small>独立 Self Media Workbench</small>}</>],
          ['Bot',owner+' · r'+row.botRevision],
          ['会话',row.roomTitle],
          ['任务',<span className="version-id">{shortId(row)}</span>]
        ]}/>
      </section>
      {row.files.length>0&&<section className="recovery-card" aria-labelledby="recovery-materials">
        <h2 id="recovery-materials">本轮材料</h2>
        <div className="recovery-files">{row.files.map(file=><a href={'#chat/'+row.conversation+'?material='+file.id} key={file.id}>
          <FileText size={16}/><span>{file.name}</span><ChevronRight size={16}/>
        </a>)}</div>
      </section>}
    </div>
  </div>;
}

export function Recovery({workspace,selected,online,refresh,notify}) {
  const [rows,setRows]=useState(null);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const [checking,setChecking]=useState(null);
  const [lastPicked,setLastPicked]=useState(null);
  const heading=useRef(null);
  useEffect(()=>{
    const control=new AbortController();
    api('/recoveries',undefined,{signal:control.signal}).then(result=>{
      if(!control.signal.aborted){setRows(result.rows);setError('');}
    }).catch(error=>{
      if(!control.signal.aborted)setError(error.message);
    });
    return ()=>control.abort();
  },[workspace.version,retry]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[selected]);

  const row=rows?.find(item=>item.id===(selected||lastPicked))??(!selected?rows?.[0]:null);
  const owner=row&&workspace.bots.find(bot=>bot.id===row.botId&&bot.revision===row.botRevision);
  async function check(current) {
    setChecking(current.id);
    setLastPicked(current.id);
    try {
      await api('/runs/'+current.id+'/recover',{});
      await refresh();
    } catch(error) {
      notify(error.message);
      await refresh();
    } finally {
      setChecking(null);
    }
  }

  return <div className="recovery-page">
    <div className="section-head">
      <div><h1 ref={heading} tabIndex={-1}>断线核对</h1>
        {row?<p><span className="version-id">{shortId(row)}</span><span aria-hidden="true"> / </span>{row.projectTitle}</p>
          :<p>在原项目查找中断的写入回执。</p>}
      </div>
      {row&&<RecoveryStatus state={row.state}/>}
    </div>
    {error&&<div className="recovery-load" role="status">{error}<button className="button" onClick={()=>setRetry(retry+1)}>重新读取</button></div>}
    {!rows&&!error&&<p className="muted" role="status">正在读取核对记录…</p>}
    {row&&<Receipt row={row} owner={owner?.name??row.botId} online={online} checking={checking!==null} onCheck={check}/>}
    {rows&&!row&&<div className="empty-page">
      <History size={23}/><h2>{selected?'找不到这项核对记录':'暂无写入核对记录'}</h2>
      <a className="button" href={selected?'#recovery':'#home'}><ArrowLeft size={16}/>{selected?'全部核对记录':'返回工作台'}</a>
    </div>}
    {rows?.length>0&&(rows.length>1||!row)&&<section className="page-list recovery-queue" aria-labelledby="recovery-queue">
      <h2 id="recovery-queue">核对记录</h2>
      {rows.map(item=><a className="page-row" href={'#recovery/'+item.id} aria-current={row?.id===item.id?'true':undefined} key={item.id}>
        <History size={17}/><span><strong>{item.projectTitle}</strong><small>{item.roomTitle} · {shortId(item)}</small></span>
        <RecoveryStatus state={item.state}/><ChevronRight size={16}/>
      </a>)}
    </section>}
  </div>;
}

