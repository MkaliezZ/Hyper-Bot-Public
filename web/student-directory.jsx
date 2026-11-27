import React,{useState} from 'react';
import {studentRecordsRequest} from './teaching-client.js';
import {TeachingRecords} from './teaching-records.jsx';
import {TeachingAccount,useTeachingSession} from './teaching-session.jsx';

export function StudentDirectory({trial}) {
  const session=useTeachingSession(studentRecordsRequest,trial);
  const [preview,setPreview]=useState(null);
  return <>
    <div className="section-head"><div><h1>学员档案</h1></div></div>
    {session.error&&<p className="form-error" role="alert">{session.error}</p>}
    {session.logged?<div className="student-directory-page">
      <section className="student-directory-card teach-fields" aria-label="学员档案浏览" ref={setPreview}/>
      <section className="student-directory-card teach-fields" aria-label="学员资料">
        <TeachingAccount session={session}/>
        <TeachingRecords area="students" title="学员资料" call={studentRecordsRequest} preview={preview} onError={session.setError}/>
      </section>
    </div>:<div className="student-directory-card teach-fields"><TeachingAccount session={session}/></div>}
  </>;
}
