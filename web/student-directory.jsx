import React,{useRef,useState} from 'react';
import {openTeachingBot,studentRecordsRequest} from './teaching-client.js';
import {TeachingRecords} from './teaching-records.jsx';
import {TeachingAccount,useTeachingSession} from './teaching-session.jsx';

const related=['teaching-students','teaching-enrollments','teaching-learning','teaching-renewals','teaching-history','teaching-classroom','teaching-practice'];

export function StudentDirectory({workspace,online,studentId}) {
  const bots=related.map(id=>workspace.bots.find(bot=>bot.id===id&&bot.status==='enabled')).filter(Boolean);
  const session=useTeachingSession(studentRecordsRequest,bots.find(bot=>bot.id==='teaching-students')?.trial!==false);
  const [preview,setPreview]=useState(null);
  const [opening,setOpening]=useState(false);
  const pending=useRef(false);
  async function openBot(botId,student='',enrollment='') {
    if(!online||pending.current)return;
    const bot=bots.find(item=>item.id===botId);
    if(!bot)return;
    pending.current=true;
    setOpening(true);
    session.setError('');
    try {
      await openTeachingBot(workspace,botId,{studentId:student,enrollmentId:enrollment});
    } catch(error) {session.setError(error.message);}
    finally {pending.current=false;setOpening(false);}
  }
  const openDisabled=!online||opening;
  return <>
    <div className="section-head"><div><h1>学员档案</h1></div></div>
    {session.error&&<p className="form-error" role="alert">{session.error}</p>}
    {session.logged?<><nav className="student-bot-links" aria-label="学员管理相关 Bot">
      {bots.map(bot=><button type="button" key={bot.id} className="button compact" disabled={openDisabled} onClick={()=>void openBot(bot.id)}>
        {bot.id==='teaching-students'?'学员档案 Bot':bot.name}</button>)}
    </nav><div className="student-directory-page">
      <section className="student-directory-card teach-fields" aria-label="学员档案浏览" ref={setPreview}/>
      <section className="student-directory-card teach-fields" aria-label="学员资料">
        <TeachingAccount session={session}/>
        <TeachingRecords area="students" title="学员资料" call={studentRecordsRequest} preview={preview} onError={session.setError}
          studentId={studentId} onOpenBot={openBot} actionsDisabled={openDisabled}/>
      </section>
    </div></>:<div className="student-directory-card teach-fields"><TeachingAccount session={session}/></div>}
  </>;
}
