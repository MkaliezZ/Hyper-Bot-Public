import React,{useEffect,useState,useRef} from 'react';
import {createPortal} from 'react-dom';
import {studentDirectoryHref} from './teaching-client.js';

const tracks={k12:'K12 英语',toefl:'托福',ielts:'雅思'};
const audience={all:'全部课程',...tracks};
const calendarState={confirmed:'已确认',tentative:'暂定',done:'已完成'};
const signalState={unverified:'待核对',verified:'已核验',dismissed:'已归档'};
const studentState={active:'在读',paused:'暂停',archived:'归档'};
const learningState={reference:'参考',used:'已上课使用',assigned:'已布置',completed:'已完成'};
const followUpState={contacted:'已联系',payment_planned:'已约付款',no_response:'未回复',paused:'暂停',resolved:'已解决'};
const renewalState={unpaid:'未续费',planned:'计划续费',paid:'已续费',opt_out:'不续费',paused:'暂停',dispute:'有争议'};
const labels={name:'姓名',code:'内部编号',className:'班级',track:'课程',status:'状态',date:'日期',title:'标题',region:'地区',sourceUrl:'来源链接',facts:'内容',recommendation:'建议',details:'备注',endOn:'到期日',label:'课程段',note:'跟进备注',outcome:'跟进结果',feedback:'反馈',issue:'问题',state:'续费状态',remainingLessons:'剩余课时',priority:'优先级',probabilityStatus:'概率估计',upliftStatus:'跟进增益',matureRows:'有效历史记录',probability:'续费概率',uplift:'跟进增益估计',attendancePct:'出勤率',renewed:'已续费',occurredOn:'活动日期',publishedOn:'发布日期',effectiveOn:'生效日期',reviewNotes:'核对记录',leadDays:'提前提醒天数',recurrence:'重复',kind:'类型',reasons:'依据',reasonsSummary:'原因',nextOn:'下次节点',phase:'阶段',daysUntil:'剩余天数',history:'历史统计',learning:'学习记录',enrollments:'课程段',student:'学员',artifact:'教学成果',renewals:'续费跟进',enrollment:'课程段',followUps:'跟进记录'};
function Summary({value}) {
  if(value==null)return null;
  if(Array.isArray(value)&&!value.length)return <span className="muted">暂无记录</span>;
  if(Array.isArray(value))return <ul>{value.map((v,i)=><li key={i}><Summary value={v}/></li>)}</ul>;
  if(typeof value==='object')return <dl>{Object.entries(value).filter(([k,v])=>v!=null&&v!==''&&!/(?:^id$|Id$|^owner$)/.test(k)).map(([k,v])=><div key={k}><dt>{labels[k]??k}</dt><dd><Summary value={v}/></dd></div>)}</dl>;
  return <>{String(value)}</>;
}

function StudentStatistics({students}) {
  const statusCounts={}, trackCounts={}, classes=new Map();
  for(const {status,track,className} of students){
    statusCounts[status]=(statusCounts[status]??0)+1;
    trackCounts[track]=(trackCounts[track]??0)+1;
    classes.set(className,(classes.get(className)??0)+1);
  }
  const classCounts=[...classes].sort(([a],[b])=>(a??'').localeCompare(b??'','zh-CN'));
  return <section className="student-records-section" aria-label="学员统计">
    <h3>全部学员 <strong>{students.length}</strong></h3>
    <dl className="student-counts" aria-label="按状态统计">{Object.entries(studentState).map(([key,label])=>
      <div key={key}><dt>{label}</dt><dd>{statusCounts[key]??0}</dd></div>)}</dl>
    <h3>按课程</h3>
    <dl className="student-counts">{Object.entries(tracks).map(([key,label])=>
      <div key={key}><dt>{label}</dt><dd>{trackCounts[key]??0}</dd></div>)}</dl>
    <h3>按班级</h3>
    {classCounts.length?<dl className="student-counts">{classCounts.map(([name,total])=>
      <div key={name?'class:'+name:'unassigned'}><dt>{name||'未分班'}</dt><dd>{total}</dd></div>)}</dl>:<p className="muted">暂无班级记录</p>}
  </section>;
}

function StudentProfile({detail,onOpenBot,actionsDisabled}) {
  const {student,enrollments,learning}=detail;
  return <section className="student-records-section" aria-label="档案详情">
    <h3>{student.name}</h3>
    <dl className="student-counts">
      <div><dt>内部编号</dt><dd>{student.code||'未填写'}</dd></div>
      <div><dt>班级</dt><dd>{student.className||'未分班'}</dd></div>
      <div><dt>课程</dt><dd>{tracks[student.track]??student.track}</dd></div>
      <div><dt>状态</dt><dd>{studentState[student.status]??student.status}</dd></div>
    </dl>
    {onOpenBot&&<div className="student-bot-links">
      <button className="button compact" type="button" disabled={actionsDisabled} onClick={()=>void onOpenBot('teaching-enrollments',student.id)}>办理课程段关联</button>
      <button className="button compact" type="button" disabled={actionsDisabled} onClick={()=>void onOpenBot('teaching-learning',student.id)}>登记学习记录</button>
      <button className="button compact" type="button" disabled={actionsDisabled} onClick={()=>void onOpenBot('teaching-classroom',student.id)}>生成互动课件</button>
      <button className="button compact" type="button" disabled={actionsDisabled} onClick={()=>void onOpenBot('teaching-practice',student.id)}>设计课后练习</button>
    </div>}
    <h3>课程段（{enrollments.length}）</h3>
    {!enrollments.length?<p className="muted">暂无关联课程段</p>:<ul className="student-records-list">
      {enrollments.map(({id,label,track,endOn,remainingLessons,attendancePct,followUps})=><li key={id}>
        <strong>{label}</strong>
        <small>{[tracks[track]??track,endOn&&'到期 '+endOn,remainingLessons!=null&&'剩余 '+remainingLessons+' 课时',
          attendancePct!=null&&'出勤 '+attendancePct+'%'].filter(Boolean).join(' · ')}</small>
        {onOpenBot&&<button className="text-button" type="button" disabled={actionsDisabled} aria-label={'续费跟进 '+label}
          onClick={()=>void onOpenBot('teaching-renewals',student.id,id)}>续费跟进</button>}
        {followUps.length>0&&<details><summary>跟进记录（{followUps.length}）</summary>
          <ul>{followUps.map(({date,outcome,note},i)=><li key={i}>
            <span>{date} · {followUpState[outcome]??outcome}</span>{note&&<p>{note}</p>}
          </li>)}</ul></details>}
      </li>)}
    </ul>}
    <h3>学习记录（{learning.length}）</h3>
    {!learning.length?<p className="muted">暂无学习记录</p>:<ul className="student-records-list">
      {learning.map(({artifactId,artifact,status,occurredOn,note,sourceRoom})=><li key={artifactId}>
        {sourceRoom?<a className="text-button" href={'#chat/'+sourceRoom+'?'+new URLSearchParams({teachingTask:artifact.taskId,student:student.id})}>
          {artifact.title}</a>:<strong>{artifact.title}</strong>}
        <small>{[artifact.kind==='lesson'?'互动课件':'练习单',learningState[status]??status,occurredOn].filter(Boolean).join(' · ')}</small>
        {note&&<p>{note}</p>}
      </li>)}
    </ul>}
  </section>;
}

function RecordStatus({error,retry,children}) {
  return error?<div className="student-records-section"><p role="alert">{error}</p>
    <button className="button compact" type="button" onClick={retry}>重新读取</button></div>:<p role="status">{children}</p>;
}

function StudentPreview({rows,selection,select,detail,error,retry,preview,onOpenBot,actionsDisabled}) {
  const [view,setView]=useState('profile'),[query,setQuery]=useState('');
  const [track,setTrack]=useState(''),[status,setStatus]=useState(''),[className,setClassName]=useState(''),[limit,setLimit]=useState(25);
  useEffect(()=>{preview.scrollTop=0;},[preview,selection,view]);
  const term=query.trim().toLocaleLowerCase();
  const classes=[...new Set(rows.map(row=>row.className??''))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const matches=rows.filter(row=>(!track||row.track===track)&&(!status||row.status===status)&&
    (!className||'class:'+ (row.className??'')===className)&&(!term||[row.name,row.code,row.className].some(value=>value?.toLocaleLowerCase().includes(term))));
  const filtered=!!(term||track||status||className);
  const change=update=>event=>{update(event.target.value);setLimit(25);};
  return <div className="student-records-section">
    <div className="student-record-tabs" role="group" aria-label="学员档案视图">
      <button type="button" aria-pressed={view==='profile'} onClick={()=>setView('profile')}>档案</button>
      <button type="button" aria-pressed={view==='statistics'} onClick={()=>setView('statistics')}>统计</button>
    </div>
    {view==='statistics'?<StudentStatistics students={rows}/>:selection?<div className="student-records-section">
      <button type="button" className="text-button student-list-back" onClick={()=>select('')}>返回学员列表</button>
      {detail?<StudentProfile detail={detail} onOpenBot={onOpenBot} actionsDisabled={actionsDisabled}/>:<RecordStatus error={error} retry={retry}>正在读取学员档案…</RecordStatus>}
    </div>:<>
      <label>查找学员<input type="search" value={query} maxLength={80} placeholder="姓名、编号或班级" onChange={change(setQuery)}/></label>
      {onOpenBot&&<div className="student-filters">
        <label>班级<select value={className} onChange={change(setClassName)}><option value="">全部班级</option>
          {classes.map(name=><option key={name} value={'class:'+name}>{name||'未分班'}</option>)}</select></label>
        <label>课程<select value={track} onChange={change(setTrack)}><option value="">全部课程</option>
          {Object.entries(tracks).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>
        <label>状态<select value={status} onChange={change(setStatus)}><option value="">全部状态</option>
          {Object.entries(studentState).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>
      </div>}
      {onOpenBot&&rows.length>0&&<p className="muted" role="status">显示 {Math.min(matches.length,limit)} 名，共 {matches.length} 名匹配学员</p>}
      {matches.length?<ul className="student-records-list student-directory" aria-label="学员列表">{(onOpenBot?matches.slice(0,limit):matches).map(row=><li key={row.id}>
        <button type="button" onClick={()=>select(row.id)}>
          <strong>{row.name}</strong><span>{studentState[row.status]??row.status}</span>
          <small>{[row.code,row.className,tracks[row.track]??row.track].filter(Boolean).join(' · ')}</small>
        </button>
      </li>)}</ul>:<p className="muted" role="status">{filtered?'没有符合条件的学员。':'暂无学员档案。'}</p>}
      {onOpenBot&&matches.length>limit&&<button className="button compact" type="button" onClick={()=>setLimit(value=>value+25)}>显示更多学员</button>}
    </>}
  </div>;
}

const optionsFor=(rows,id='id',label='title')=>Object.fromEntries(rows.map(row=>[row[id],row[label]]));
function Field({name,title,options,value,type='text',required,change,...constraints}) {
  const props={name,required,defaultValue:value,onChange:change};
  return <label>{title||labels[name]||name}{options?<select aria-label={title||labels[name]||name} {...props}>{Object.entries(options).map(([v,s])=><option value={v} key={v}>{s}</option>)}</select>:
    type==='textarea'?<textarea rows={3} {...props} {...constraints}/>:<input type={type} {...props} {...constraints}/>}</label>;
}

function LearningFields({artifacts,learning,artifactId}) {
  const [selection,select]=useState(artifactId??'');
  const artifact=artifacts.find(row=>row.artifactId===(selection||learning?.[0]?.artifactId))??artifacts[0];
  const saved=learning?.find(row=>row.artifactId===artifact.artifactId);
  const modes=artifact.kind==='lesson'?['reference','used']:['reference','assigned','completed'];
  return <>
    <Field name="artifactId" title="课件或练习" options={optionsFor(artifacts,'artifactId','title')}
      value={artifact.artifactId} change={event=>select(event.target.value)} required/>
    <React.Fragment key={artifact.artifactId}>
      <Field name="status" options={Object.fromEntries(modes.map(mode=>[mode,learningState[mode]]))} value={saved?.status}/>
      <Field name="occurredOn" type="date" value={saved?.occurredOn??''}/>
      <Field name="note" title="学习备注" type="textarea" value={saved?.note}/>
    </React.Fragment>
  </>;
}

export function TeachingRecords({area,title,call,preview,onError,directoryLinks,studentId,enrollmentId,artifactId,onOpenBot,actionsDisabled,openRelated}) {
  const students=['students','enrollments','learning'].includes(area);
  const renewals=area==='renewals';
  const [list,setList]=useState(null),[selection,select]=useState((students?studentId:renewals?enrollmentId:'')??'');
  const [read,setRead]=useState(null),[busy,setBusy]=useState(false);
  const [renewalStudent,setRenewalStudent]=useState(renewals?studentId??'':''),[courseAction,setCourseAction]=useState('');
  const [receipt,setReceipt]=useState(''),[reload,setReload]=useState(0),[csv,setCsv]=useState(''),[loadError,setLoadError]=useState('');
  const replay=useRef(null), gate=useRef(false);
  const retry=()=>{setLoadError('');setReload(v=>v+1);};
  useEffect(()=>{
    const ctrl=new AbortController();
    call('records',{signal:ctrl.signal}).then(v=>{
      if(!ctrl.signal.aborted){setList(v);setLoadError('');}
    }).catch(e=>{if(!ctrl.signal.aborted)setLoadError(e.message);});
    return ()=>ctrl.abort();
  },[call,reload]);
  useEffect(()=>{
    if(!students||!selection)return;
    const ctrl=new AbortController();
    call('detail?id='+encodeURIComponent(selection),{signal:ctrl.signal}).then(detail=>{
      if(!ctrl.signal.aborted)setRead({selection,reload,detail});
    }).catch(e=>{if(!ctrl.signal.aborted)setRead({selection,reload,error:e.message});});
    return ()=>ctrl.abort();
  },[call,selection,students,reload]);
  const current=read?.selection===selection&&read.reload===reload?read:null;
  const detail=current?.detail;
  const rows=students?list?.students:area==='calendar'?list?.calendar:area==='signals'?list?.signals:
    renewals?list?.renewals.filter(row=>!renewalStudent||row.studentId===renewalStudent):null;
  const selected=students?detail?.student:rows?.find(row=>(row.enrollment?.id??row.id)===selection);
  const result=area==='history'?list?.history:renewals&&selected
    ? {...selected,followUps:list.followUps?.[selected.enrollment.id]??[]}:selected??rows;
  const previewBody=!list?<RecordStatus error={loadError} retry={retry}>正在读取教培记录…</RecordStatus>:
    students?<StudentPreview rows={rows} selection={selection} select={select} detail={detail} error={current?.error} retry={retry} preview={preview}
      onOpenBot={onOpenBot} actionsDisabled={actionsDisabled}/>:
      result?<Summary value={result}/>:<p className="muted">选择记录后查看详情。</p>;
  async function write(action,body) {
    if(gate.current)return;gate.current=true;setBusy(true);onError('');setReceipt('');
    const student=renewals?(renewalStudent||selected?.studentId):'';
    const signature=JSON.stringify([action,selection,student,body]);
    if(replay.current?.signature!==signature)replay.current={signature,key:crypto.randomUUID()};
    try {
      const result=await call('record-write',{body:{action,record:selection,key:replay.current.key,input:body,...(student?{student}:{})}});
      replay.current=null;
      setReceipt(result.imported!==undefined?'已导入 '+result.imported+' 条记录。':'已保存教培记录。');
      if(result.student)select(result.student.id);
      else if(['calendar','signals'].includes(area)&&result.id)select(result.id);
      setReload(v=>v+1);
      if(area==='history')setCsv('');
    }catch(e){onError(e.message);}finally{gate.current=false;setBusy(false);}
  }
  const renderedPreview=preview&&createPortal(previewBody,preview);
  if(!list)return <><RecordStatus error={loadError} retry={retry}>正在读取教培记录…</RecordStatus>{renderedPreview}</>;
  const courseRows=list.enrollments??[];
  const available=courseRows.filter(row=>!row.studentId);
  const courseOperation=courseAction||(!available.length&&list.canCreateEnrollment?'create':'link');
  const enrollmentChoices=courseOperation==='unlink'?courseRows.filter(row=>row.studentId===selection):available;
  let missingOptions='';
  if(area==='enrollments'&&courseOperation!=='create'&&!enrollmentChoices.length){
    missingOptions=courseOperation==='unlink'?'这名学员暂无可解除的课程段。':'暂无可关联的课程段，可从「运营数据导入」导入续费名单。';
  }
  if(area==='learning'&&!list.artifacts.length)missingOptions='请先用「课上互动课件」或「课后练习设计」生成成果。';
  if(renewals&&!rows.length)missingOptions=renewalStudent?'这名学员暂无可跟进的课程段，请先关联课程段。':'暂无续费记录，请先关联课程段或导入续费名单。';
  const requiresSelection=['renewals','enrollments','learning'].includes(area);
  const studentForReturn=students?selection:renewals?(selected?.studentId??renewalStudent):'';
  const submit=event=>{
    event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget));let action=area;
    if(area==='calendar'){form.leadDays=Number(form.leadDays);if(selection)form.id=selection;}
    if(area==='signals'){form.effectiveOn||=null;if(selection)form.id=selection;}
    if(missingOptions||requiresSelection&&!selected||students&&selection&&!detail)return;
    if(area==='students'&&selection)form.expectedVersion=detail.student.version;
    if(area==='history'){action=form.dataset;delete form.dataset;form.csv=csv;}
    if(area==='enrollments'){
      action=courseOperation;
      if(action==='create'){
        form.endOn||=null;
        form.remainingLessons=form.remainingLessons===''?null:Number(form.remainingLessons);
        form.contactAllowed=form.contactAllowed==='true';
      }
    }
    if(area==='learning')form.occurredOn||=null;
    void write(action,form);
  };
  return <><div className="student-record-title"><h2>{title}</h2>
    {directoryLinks&&(students||renewals||area==='history')&&<a className="text-button" href={studentDirectoryHref(studentForReturn)}>返回学员档案</a>}
    {onOpenBot&&selection&&<button className="button compact" type="button" onClick={()=>select('')}>新建学员</button>}
  </div>
  {loadError&&<RecordStatus error={loadError} retry={retry}/>}
  {receipt&&<p role="status">{receipt}</p>}
  {renewals&&<label>学员<select value={renewalStudent} onChange={event=>{
    const student=event.target.value;
    const matching=list.renewals.filter(row=>row.studentId===student);
    setRenewalStudent(student);
    select(student&&matching.length===1?matching[0].enrollment.id:'');
  }}><option value="">全部学员及未关联记录</option>{list.students.map(row=>
    <option key={row.id} value={row.id}>{[row.name,row.className,row.code].filter(Boolean).join(' · ')}</option>)}</select></label>}
  {rows&&<label>{students?'学员':renewals?'课程段':'记录'}<select value={selection} onChange={e=>select(e.target.value)}><option value="">{['students','calendar','signals'].includes(area)?'新建记录':'选择记录'}</option>{rows.map(row=><option key={row.enrollment?.id??row.id} value={row.enrollment?.id??row.id}>{row.name??row.title??row.enrollment?.label}</option>)}</select></label>}
  {students&&selection&&!detail&&<RecordStatus error={current?.error} retry={retry}>正在读取学员档案…</RecordStatus>}
  {area==='enrollments'&&selected&&<label>操作<select value={courseOperation} onChange={event=>setCourseAction(event.target.value)}>
    {list.canCreateEnrollment&&<option value="create">新建并关联课程段</option>}
    <option value="link">关联已有课程段</option><option value="unlink">解除课程段关联</option>
  </select></label>}
  {(!students||!selection||detail)&&<form key={selection+'-'+reload} className="teach-fields" onSubmit={submit}>
  {area==='calendar'&&<><Field name="title" value={selected?.title} required/><Field name="track" options={audience} value={selected?.track}/><Field name="date" type="date" value={selected?.date} required/><Field name="leadDays" type="number" value={selected?.leadDays??7} required/><Field name="recurrence" options={{once:'一次',annual:'每年'}} value={selected?.recurrence}/><Field name="status" options={calendarState} value={selected?.status}/><Field name="sourceUrl" value={selected?.sourceUrl}/><Field name="details" type="textarea" value={selected?.details}/></>}
  {area==='signals'&&<><Field name="kind" options={{policy:'政策',hotspot:'热点'}} value={selected?.kind}/><Field name="title" value={selected?.title} required/><Field name="track" options={audience} value={selected?.track}/><Field name="region" value={selected?.region} required/><Field name="sourceUrl" type="url" value={selected?.sourceUrl} required/><Field name="publishedOn" type="date" value={selected?.publishedOn} required/><Field name="effectiveOn" type="date" value={selected?.effectiveOn}/><Field name="status" options={signalState} value={selected?.status}/><Field name="facts" type="textarea" value={selected?.facts} required/><Field name="reviewNotes" value={selected?.reviewNotes}/><button type="button" className="button" disabled={busy} onClick={()=>void write('refresh',{})}>刷新订阅来源</button></>}
  {renewals&&selected&&<><Field name="date" type="date" value={list.today} max={list.today} required/><Field name="outcome" options={followUpState}/><Field name="note" type="textarea" maxLength={400}/></>}
  {area==='history'&&<><Field name="dataset" title="导入类型" options={{renewalImport:'续费名单',historyImport:'历史结果'}}/><label>CSV 文件<input type="file" accept=".csv" onChange={async e=>{const file=e.target.files[0];if(!file)return;if(file.size>262144){onError('CSV 上限为 256 KiB。');return;}try{setCsv(await file.text());}catch{onError('无法读取 CSV 文件。');}}}/></label><label>核对 CSV<textarea required rows={6} value={csv} onChange={e=>setCsv(e.target.value)}/></label></>}
  {area==='students'&&<><Field name="name" value={selected?.name} required/><Field name="code" value={selected?.code}/><Field name="className" value={selected?.className}/><Field name="track" options={tracks} value={selected?.track}/><Field name="status" options={studentState} value={selected?.status}/></>}
  {area==='enrollments'&&selected&&!missingOptions&&(courseOperation==='create'?<>
    <Field name="label" title="课程段名称" maxLength={60} required/>
    <Field name="track" options={tracks} value={selected.track}/><Field name="endOn" type="date"/>
    <Field name="remainingLessons" type="number" min={0} max={10000} step="any"/>
    <Field name="state" options={renewalState}/><Field name="contactAllowed" title="已获授权联系" options={{false:'否',true:'是'}}/>
  </>:<Field name="enrollmentId" title="课程段" key={courseOperation} options={optionsFor(enrollmentChoices,'id','label')} required/>)}
  {area==='learning'&&!missingOptions&&<LearningFields artifacts={list.artifacts} learning={detail?.learning} artifactId={artifactId}/>}
  {missingOptions&&<p className="muted">{missingOptions}</p>}
  {missingOptions&&openRelated&&<div className="student-bot-links">
    {renewals&&(renewalStudent
      ?<button className="button compact" type="button" disabled={busy} onClick={()=>void openRelated('teaching-enrollments',renewalStudent)}>办理课程段关联</button>
      :<button className="button compact" type="button" disabled={busy} onClick={()=>void openRelated('teaching-history')}>导入续费名单</button>)}
    {area==='enrollments'&&courseOperation==='link'&&<button className="button compact" type="button" disabled={busy}
      onClick={()=>void openRelated('teaching-history')}>导入续费名单</button>}
    {area==='learning'&&<>
      <button className="button compact" type="button" disabled={busy} onClick={()=>void openRelated('teaching-classroom',selection)}>生成互动课件</button>
      <button className="button compact" type="button" disabled={busy} onClick={()=>void openRelated('teaching-practice',selection)}>设计课后练习</button>
    </>}
  </div>}
  <button className="button primary" disabled={busy||!!missingOptions||requiresSelection&&!selected}>{area==='history'?'确认导入':'保存记录'}</button></form>}
  {renderedPreview}</>;
}
