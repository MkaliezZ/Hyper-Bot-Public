import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ClipboardList, Download, X } from 'lucide-react';
import { api, clock, day, runHref, runPhase } from './client.js';

const categories={work:'工作会话',simulation:'演练与测试',verification:'候选验证'};
const usageLabels={reported:'用量已报',missing:'用量缺报',legacy:'旧版口径',no_call:'未调用模型',pending:'等待用量'};
const billErrors=new Set(['bill_reference','bill_entry_conflict']);
const format=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
const number=value=>value==null?'—':format.format(value);
const money=value=>value==null?'待核对':'¥'+value;
const duration=value=>value==null?'—':number(value/1000)+' 秒';
const active=record=>!record.finishedAt;
const stamp=date=>day(date)+' '+clock(date);

function downloadReport(report) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='Hyper Bot 运行回执 '+report.filters.category+' '+report.through.slice(0,10)+'.json';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}

function Metrics({summary,category}) {
  const {tokens,accounting}=summary;
  const cells=[
    ['任务',number(summary.total)],
    [category==='verification'?'通过':'已交付',number(category==='verification'?summary.verified:summary.delivered)],
    ['重试',number(summary.retries)],
    ['缺报及旧口径',number(summary.missing)],
  ];
  const totals=[
    ['输入 token',number(tokens.input.total)],
    ['输出 token',number(tokens.output.total)],
    ['命中缓存 token',number(tokens.cached.total)],
    ['已核对金额',money(accounting.amountCny)],
  ];
  return <section className="manage-card receipts-summary" aria-label="本期汇总">
    <dl className="receipt-metrics">{cells.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <dl className="receipt-metrics receipt-totals">{totals.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="receipt-method">
      失败率 {summary.failureRate==null?'—':number(summary.failureRate*100)+'%'} · 停止 {number(summary.cancelled)} 次
      {summary.averageTokens!==null&&<> · 每份交付 {number(summary.averageTokens)} token</>}
      {accounting.averageCny!==null&&<> · 每份交付 {money(accounting.averageCny)}</>}
    </p>
    <p className="receipt-method">
      {accounting.activeSeconds.total===null?'人工时长待登记':'人工已登记 '+number(accounting.activeSeconds.total)+' 秒'}
      {' · '+(accounting.relationshipUses.total===null?'关系动用待登记':'关系已登记 '+number(accounting.relationshipUses.total)+' 次')}
      {accounting.cashMissing>0&&<> · {number(accounting.cashMissing)} 项账单待核对</>}
    </p>
    {accounting.billConflicts>0&&<p className="receipt-method bill-warning">{number(accounting.billConflicts)} 轮的账单条目重复，金额待复核。</p>}
    <p className="receipt-method">用量汇总计入本期失败和重试的已报告值。旧版口径保留在逐轮记录。</p>
  </section>;
}

function RunRow({row,bot,driver,online,onEdit}) {
  const {usage,accounting}=row;
  const phase=row.recoveryPending?'写入待核对':row.reconciled?'已找回稿件':runPhase(row);
  const waiting=row.recoveryPending||row.stop?.outcome==='unconfirmed'||['waiting_approval','stopping'].includes(row.state);
  const kind=row.delivered||row.state==='succeeded'?'success':waiting?'wait':'';
  const status=row.role==='maintainer'?'维护者':'用户';
  const heading='receipt-'+row.id;
  const used=[
    ['输入',number(usage.input)],['输出',number(usage.output)],['缓存命中',number(usage.cached)]
  ];
  const showRef=usage.requestId||usage.responseId;
  return <article className="manage-card receipt-row" aria-labelledby={heading}>
    <div className="receipt-row-head">
      <div>
        <h3 id={heading}>{bot?.name??row.botId} <span className="version">r{row.botRevision}</span></h3>
        <p className="muted">{driver?.name??row.driver}{row.model?' · '+row.model:''}</p>
      </div>
      <span className={'chip '+kind}>{phase}</span>
    </div>
    <div className="receipt-meta">
      <code title={row.id}>{row.id.slice(0,8)}</code>
      <time dateTime={row.createdAt}>{stamp(row.createdAt)}</time>
      <span>{status}</span><span>{duration(row.elapsedMs)}</span>
      {row.modelMode==='test'&&<span>模型夹具</span>}
      {row.retryOf&&<span>重试 {row.retryOf.slice(0,8)}</span>}
    </div>
    {row.reason&&<p className="receipt-reason">{row.reason}</p>}
    <dl className="receipt-metrics row-tokens">
      {used.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      <div><dt>模型请求</dt><dd>{number(usage.requests)}</dd></div>
    </dl>
    <div className="receipt-meta">
      <span className={'chip '+(usage.status==='missing'?'wait':'')}>{usageLabels[usage.status]}</span>
      {usage.protocol&&<code>{usage.protocol==='messages'?'Anthropic Messages':'Chat Completions'}</code>}
      {showRef&&<details className="receipt-ref"><summary>提供方编号</summary>
        {usage.requestId&&<p>请求 <code>{usage.requestId}</code></p>}
        {usage.responseId&&<p>响应 <code>{usage.responseId}</code></p>}
      </details>}
    </div>
    {accounting&&<p className="receipt-accounted">人工 {number(accounting.activeSeconds)} 秒 · 关系 {number(accounting.relationshipUses)} 次
      {' · '+money(accounting.amountCny)}
      {row.billConflict&&<span className="bill-warning"> · 账单条目重复</span>}</p>}
    <div className="manage-actions receipt-row-actions">
      {row.conversation&&<a className="button compact" href={runHref(row)}>查看任务<ArrowUpRight size={15}/></a>}
      {!active(row)&&<button type="button" className="button compact" disabled={!online} onClick={()=>onEdit(row)}>
        <ClipboardList size={15}/>{accounting?'编辑核对记录':'登记实际记录'}
      </button>}
    </div>
  </article>;
}

function AccountingDialog({row,refresh,close,notify}) {
  const dialog=useRef(null),timer=useRef(null),billField=useRef(null);
  const [saving,setSaving]=useState(false),[closing,setClosing]=useState(false),[error,setError]=useState(null);
  const current=row.accounting;
  const billError=billErrors.has(error?.code);
  useEffect(()=>{
    const node=dialog.current;
    node.showModal();
    return ()=>{clearTimeout(timer.current);if(node.open)node.close();};
  },[]);
  function dismiss() {
    if(saving||closing)return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)close();
    else {setClosing(true);timer.current=setTimeout(close,120);}
  }
  async function save(event) {
    event.preventDefault();
    if(saving||closing)return;
    const fields=new FormData(event.currentTarget);
    const text=name=>String(fields.get(name)??'').trim()||null;
    const integer=name=>text(name)===null?null:Number(text(name));
    setSaving(true);setError(null);
    try {
      await api('/receipts/'+row.id+'/accounting',{
        expectedRevision:current?.revision??0,
        activeSeconds:integer('activeSeconds'),relationshipUses:integer('relationshipUses'),relationshipRef:text('relationshipRef'),
        amountCny:text('amountCny'),billRef:text('billRef')
      });
      await refresh();
      notify('已登记实际记录。');
      close();
    } catch(problem) {
      setError(problem);
      if(billErrors.has(problem.code))billField.current?.focus();
    }
    finally {setSaving(false);}
  }
  return <dialog className={'modal accounting-dialog'+(closing?' closing':'')} ref={dialog}
    aria-labelledby="accounting-title" onCancel={event=>{event.preventDefault();dismiss();}}>
    <div className="modal-head"><h2 id="accounting-title">账单与人工记录</h2>
      <button type="button" className="icon-button" disabled={saving} aria-label="关闭核对记录" onClick={dismiss}><X size={19}/></button></div>
    <p className="muted">任务 <code>{row.id.slice(0,8)}</code>。未核对的项目留空。</p>
    {row.usage.requestId&&<p className="muted billing-request">提供方请求 <code>{row.usage.requestId}</code></p>}
    <form onSubmit={save}>
      <div className="field-grid">
        <label>人工处理秒数<input name="activeSeconds" type="number" min={0} max={31536000} step={1} defaultValue={current?.activeSeconds??''}/></label>
        <label>关系动用次数<input name="relationshipUses" type="number" min={0} max={10000} step={1} defaultValue={current?.relationshipUses??''}/></label>
      </div>
      <label>关系动用记录编号<input name="relationshipRef" maxLength={160} defaultValue={current?.relationshipRef??''}/></label>
      <div className="field-grid">
        <label>已核对金额（元）<input name="amountCny" inputMode="decimal" maxLength={15} defaultValue={current?.amountCny??''}/></label>
        <div>
          <label>账单条目编号<input ref={billField} name="billRef" maxLength={160} defaultValue={current?.billRef??''}
            aria-invalid={billError||undefined} aria-describedby={billError?'bill-entry-error':undefined}
            onChange={()=>{if(billError)setError(null);}}/></label>
          {billError&&<p className="form-error" id="bill-entry-error" role="alert">{error.message}</p>}
        </div>
      </div>
      {error&&!billError&&<p className="form-error" role="alert">{error.message}</p>}
      <div className="modal-actions">
        <button type="button" className="button" disabled={saving} onClick={dismiss}>取消</button>
        <button type="submit" className="button primary" disabled={saving||closing}>{saving?'正在登记…':'保存实际记录'}</button>
      </div>
    </form>
  </dialog>;
}

export function RunReceipts({workspace,online,refresh,notify}) {
  const [category,setCategory]=useState('work'),[days,setDays]=useState('30');
  const [loaded,setLoaded]=useState(null),[failure,setFailure]=useState(null),[limit,setLimit]=useState(30);
  const [editing,setEditing]=useState(null);
  const heading=useRef(null),origin=useRef(null);
  const query=new URLSearchParams({category,days}).toString();
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
  useEffect(()=>{
    const pending=new AbortController();
    api('/receipts?'+query,undefined,{signal:pending.signal}).then(data=>{
      if(!pending.signal.aborted){setFailure(null);setLoaded({query,data});}
    }).catch(error=>{
      if(!pending.signal.aborted)setFailure({query,message:error.message});
    });
    return ()=>pending.abort();
  },[query,workspace.version]);
  const report=loaded?.query===query?loaded.data:null;
  const error=failure?.query===query?failure.message:'';
  function close() {
    setEditing(null);
    requestAnimationFrame(()=>origin.current?.focus({preventScroll:true}));
  }
  return <div className="receipts-page tab-in">
    <div className="receipt-report-head">
      <h2 ref={heading} tabIndex={-1}>运行回执</h2>
      <button type="button" className="button" disabled={!report?.rows.length||!!error||!online} onClick={()=>downloadReport(report)}>
        <Download size={16}/>导出回执
      </button>
    </div>
    <div className="receipt-filters">
      <label>任务类型<select value={category} onChange={event=>{setCategory(event.target.value);setLimit(30);}}>
        {Object.entries(categories).map(([key,label])=><option value={key} key={key}>{label}</option>)}
      </select></label>
      <label>统计周期<select value={days} onChange={event=>{setDays(event.target.value);setLimit(30);}}>
        <option value="7">近 7 天</option><option value="30">近 30 天</option>
        <option value="90">近 90 天</option><option value="all">全部</option>
      </select></label>
    </div>
    {error&&<p className="form-error" role="status">{error}</p>}
    {!report&&!error&&<p className="muted" role="status">正在读取回执…</p>}
    {report&&<div className="receipts-stack">
      {report.rows.length===0?<div className="empty-page"><ClipboardList size={23}/><h3>本期暂无回执</h3></div>:<>
        <Metrics summary={report.summary} category={category}/>
        {report.rows.slice(0,limit).map(row=><RunRow key={row.id} row={row} online={online}
          bot={workspace.bots.find(bot=>bot.id===row.botId&&bot.revision===row.botRevision)}
          driver={workspace.drivers.find(driver=>driver.id===row.driver)}
          onEdit={row=>{origin.current=document.activeElement;setEditing(row);}}/>)}
        {report.rows.length>limit&&<button className="button" onClick={()=>setLimit(limit+30)}>显示更多回执</button>}
      </>}
    </div>}
    {editing&&<AccountingDialog row={editing} refresh={refresh} close={close} notify={notify}/>}
  </div>;
}

