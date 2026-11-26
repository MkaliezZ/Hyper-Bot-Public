import React,{useEffect,useState,useRef} from 'react';

const tracks={k12:'K12 英语',toefl:'托福',ielts:'雅思'};
const audience={all:'全部课程',...tracks};
const calendarState={confirmed:'已确认',tentative:'暂定',done:'已完成'};
const signalState={unverified:'待核对',verified:'已核验',dismissed:'已归档'};
const studentState={active:'在读',paused:'暂停',archived:'归档'};
const labels={name:'姓名',code:'内部编号',className:'班级',track:'课程',status:'状态',date:'日期',title:'标题',region:'地区',sourceUrl:'来源链接',facts:'内容',recommendation:'建议',details:'备注',endOn:'到期日',label:'课程段',note:'跟进备注',outcome:'跟进结果',feedback:'反馈',issue:'问题',state:'续费状态',remainingLessons:'剩余课时',priority:'优先级',probabilityStatus:'概率估计',upliftStatus:'跟进增益',matureRows:'有效历史记录',probability:'续费概率',uplift:'跟进增益估计',attendancePct:'出勤率',renewed:'已续费',occurredOn:'活动日期',publishedOn:'发布日期',effectiveOn:'生效日期',reviewNotes:'核对记录',leadDays:'提前提醒天数',recurrence:'重复',kind:'类型',reasons:'依据',reasonsSummary:'原因',nextOn:'下次节点',phase:'阶段',daysUntil:'剩余天数',history:'历史统计',learning:'学习记录',enrollments:'课程段',student:'学员',artifact:'教学成果',renewals:'续费跟进',enrollment:'课程段',followUps:'跟进记录'};
function Summary({value}) {
  if(value==null)return null;
  if(Array.isArray(value)&&!value.length)return <span className="muted">暂无记录</span>;
  if(Array.isArray(value))return <ul>{value.map((v,i)=><li key={i}><Summary value={v}/></li>)}</ul>;
  if(typeof value==='object')return <dl>{Object.entries(value).filter(([k,v])=>v!=null&&v!==''&&!/(?:^id$|Id$|^owner$)/.test(k)).map(([k,v])=><div key={k}><dt>{labels[k]??k}</dt><dd><Summary value={v}/></dd></div>)}</dl>;
  return <>{String(value)}</>;
}
const optionsFor=(rows,id='id',label='title')=>Object.fromEntries(rows.map(row=>[row[id],row[label]]));
function Field({name,title,options,value,type='text',required,change}) {
  const props={name,required,defaultValue:value,onChange:change};
  return <label>{title||labels[name]||name}{options?<select aria-label={title||labels[name]||name} {...props}>{Object.entries(options).map(([v,s])=><option value={v} key={v}>{s}</option>)}</select>:
    type==='textarea'?<textarea rows={3} {...props}/>:<input type={type} {...props}/>}</label>;
}
export function TeachingRecords({bot,call,onPreview,onError}) {
  const area=bot.id.slice('teaching-'.length), students=bot.target==='students';
  const [list,setList]=useState(null),[selection,select]=useState(''),[detail,setDetail]=useState(null),[busy,setBusy]=useState(false);
  const [receipt,setReceipt]=useState(''),[reload,setReload]=useState(0),[csv,setCsv]=useState(''),[query,setQuery]=useState('');
  const replay=useRef(null), gate=useRef(false);
  useEffect(()=>{
    const ctrl=new AbortController();
    call('records'+(students?'?q='+encodeURIComponent(query):''),{signal:ctrl.signal}).then(v=>{if(!ctrl.signal.aborted)setList(v);}).catch(e=>{if(!ctrl.signal.aborted)onError(e.message);});
    return ()=>ctrl.abort();
  },[call,query,reload,students,onError]);
  useEffect(()=>{
    setDetail(null);if(!students||!selection)return;
    const ctrl=new AbortController();call('detail?id='+encodeURIComponent(selection),{signal:ctrl.signal}).then(v=>{if(!ctrl.signal.aborted)setDetail(v);}).catch(e=>{if(!ctrl.signal.aborted)onError(e.message);});
    return ()=>ctrl.abort();
  },[call,selection,students,reload,onError]);
  const rows=students?list?.students:area==='calendar'?list?.calendar:area==='signals'?list?.signals:area==='renewals'?list?.renewals:null;
  const selected=students?detail?.student:rows?.find(row=>(row.enrollment?.id??row.id)===selection);
  useEffect(()=>{
    const result=students?detail:area==='history'?list?.history:area==='renewals'&&selected
      ? {...selected,followUps:list.followUps?.[selected.enrollment.id]??[]}:selected??rows;
    onPreview(result?<Summary value={result}/>:<p className="muted">选择记录后查看详情。</p>);
    return ()=>onPreview(null);
  },[students,area,detail,selected,rows,list,onPreview]);
  async function write(action,body) {
    if(gate.current)return;gate.current=true;setBusy(true);onError('');setReceipt('');
    const signature=JSON.stringify([action,selection,body]);
    if(replay.current?.signature!==signature)replay.current={signature,key:crypto.randomUUID()};
    try {
      const result=await call('record-write',{body:{action,record:selection,key:replay.current.key,input:body}});
      replay.current=null;
      setReceipt(result.imported!==undefined?'已导入 '+result.imported+' 条记录。':'已保存教培记录。');
      if(result.student)select(result.student.id);
      else if(['calendar','signals'].includes(area)&&result.id)select(result.id);
      setReload(v=>v+1);
      if(area==='history')setCsv('');
    }catch(e){onError(e.message);}finally{gate.current=false;setBusy(false);}
  }
  if(!list)return <p role="status">正在读取教培记录…</p>;
  const submit=event=>{
    event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget));let action=area;
    if(area==='calendar'){form.leadDays=Number(form.leadDays);if(selection)form.id=selection;}
    if(area==='signals'){form.effectiveOn||=null;if(selection)form.id=selection;}
    if(area==='students'&&selection)form.expectedVersion=detail.student.version;
    if(area==='history'){action=form.dataset;delete form.dataset;form.csv=csv;}
    if(area==='enrollments'){action=form.operation;delete form.operation;}
    if(area==='learning')form.occurredOn||=null;
    void write(action,form);
  };
  return <><h2>{bot.name}</h2>{students&&<label>查找学员<input value={query} maxLength={80} onChange={e=>{select('');setQuery(e.target.value);}}/></label>}
  {receipt&&<p role="status">{receipt}</p>}
  {rows&&<label>{students?'学员':'记录'}<select aria-label={students?'学员':'记录'} value={selection} onChange={e=>select(e.target.value)}><option value="">{['students','calendar','signals'].includes(area)?'新建记录':'选择记录'}</option>{rows.map(row=><option key={row.enrollment?.id??row.id} value={row.enrollment?.id??row.id}>{row.name??row.title??row.enrollment?.label}</option>)}</select></label>}
  {(!students||!selection||detail)&&<form key={selection+'-'+reload} className="teach-fields" onSubmit={submit}>
  {area==='calendar'&&<><Field name="title" value={selected?.title} required/><Field name="track" options={audience} value={selected?.track}/><Field name="date" type="date" value={selected?.date} required/><Field name="leadDays" type="number" value={selected?.leadDays??7} required/><Field name="recurrence" options={{once:'一次',annual:'每年'}} value={selected?.recurrence}/><Field name="status" options={calendarState} value={selected?.status}/><Field name="sourceUrl" value={selected?.sourceUrl}/><Field name="details" type="textarea" value={selected?.details}/></>}
  {area==='signals'&&<><Field name="kind" options={{policy:'政策',hotspot:'热点'}} value={selected?.kind}/><Field name="title" value={selected?.title} required/><Field name="track" options={audience} value={selected?.track}/><Field name="region" value={selected?.region} required/><Field name="sourceUrl" type="url" value={selected?.sourceUrl} required/><Field name="publishedOn" type="date" value={selected?.publishedOn} required/><Field name="effectiveOn" type="date" value={selected?.effectiveOn}/><Field name="status" options={signalState} value={selected?.status}/><Field name="facts" type="textarea" value={selected?.facts} required/><Field name="reviewNotes" value={selected?.reviewNotes}/><button type="button" className="button" disabled={busy} onClick={()=>void write('refresh',{})}>刷新订阅来源</button></>}
  {area==='renewals'&&<><Field name="date" type="date" required/><Field name="outcome" options={{contacted:'已联系',payment_planned:'已约付款',no_response:'未回复',paused:'暂停',resolved:'已解决'}}/><Field name="note" type="textarea"/></>}
  {area==='history'&&<><Field name="dataset" title="导入类型" options={{renewalImport:'续费名单',historyImport:'历史结果'}}/><label>CSV 文件<input type="file" accept=".csv" onChange={async e=>{const file=e.target.files[0];if(!file)return;if(file.size>262144){onError('CSV 上限为 256 KiB。');return;}try{setCsv(await file.text());}catch{onError('无法读取 CSV 文件。');}}}/></label><label>核对 CSV<textarea required rows={6} value={csv} onChange={e=>setCsv(e.target.value)}/></label></>}
  {area==='students'&&<><Field name="name" value={selected?.name} required/><Field name="code" value={selected?.code}/><Field name="className" value={selected?.className}/><Field name="track" options={tracks} value={selected?.track}/><Field name="status" options={studentState} value={selected?.status}/></>}
  {area==='enrollments'&&<><Field name="enrollmentId" title="课程段" options={optionsFor(list.enrollments.filter(row=>!row.studentId||row.studentId===selection),'id','label')} required/><Field name="operation" title="操作" options={{link:'关联课程段',unlink:'解除关联'}}/></>}
  {area==='learning'&&<><Field name="artifactId" title="课件或练习" options={optionsFor(list.artifacts,'artifactId','title')} required/><Field name="status" options={{reference:'参考',used:'已上课使用',assigned:'已布置',completed:'已完成'}}/><Field name="occurredOn" type="date"/><Field name="note" type="textarea"/></>}
  <button className="button primary" disabled={busy||(['renewals','enrollments','learning'].includes(area)&&!selection)}>{area==='history'?'确认导入':'保存记录'}</button></form>}</>;
}
