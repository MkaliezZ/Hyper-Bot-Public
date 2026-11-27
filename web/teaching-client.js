import {api,apiPath,currentWorkspace,routeTo} from './client.js';

const sessionKey='hyper-bot:teaching-session:'+currentWorkspace;
export function teacherSession(value) {
  if(value===null)sessionStorage.removeItem(sessionKey);
  else if(value!==undefined)sessionStorage.setItem(sessionKey,value);
  return sessionStorage.getItem(sessionKey);
}
async function requestTeaching(base,action,{body,signal,file,blob}={}) {
  const headers={'X-Hyper-Teaching':teacherSession()??'','X-Hyper-Bot':'1'};
  let payload;
  if(file){payload=new FormData();payload.append('file',file);}
  else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
  const response=await fetch(apiPath(base+action),{
    method:payload===undefined?'GET':'POST',headers,body:payload,signal,cache:'no-store'
  });
  if(!response.ok) {
    const result=await response.json().catch(()=>({}));
    if(response.status===401&&action!=='login'&&headers['X-Hyper-Teaching']===teacherSession()){
      teacherSession(null);window.dispatchEvent(new Event('teaching-expired'));
    }
    if(base==='/teaching/students/'&&response.status===404&&result.code==='not_found'){
      throw new Error('当前运行的后端缺少学员档案接口。请从更新后的 Hyper Bot 目录重启应用。');
    }
    throw new Error(result.error??'暂时无法连接英语教培工作台。');
  }
  return blob?response.blob():response.json();
}

export function teachingRequest(room,action,options) {
  return requestTeaching('/rooms/'+room+'/teaching/',action,options);
}

export function studentRecordsRequest(action,options) {
  return requestTeaching('/teaching/students/',action,options);
}

export function studentContext(params) {
  const uuid=key=>{
    const value=params.get(key)??'';
    return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)?value:'';
  };
  const enrollment=params.get('enrollment')??'';
  return {
    studentId:uuid('student'),
    enrollmentId:/^[a-z\d][a-z\d_-]{0,63}$/i.test(enrollment)?enrollment:'',
    artifactId:uuid('learningArtifact'),
    taskId:uuid('teachingTask')
  };
}

export const studentDirectoryHref=studentId=>'#students'+(studentId?'?'+new URLSearchParams({student:studentId}):'');

export async function openTeachingBot(workspace,botId,{studentId,enrollmentId,artifactId}={}) {
  const room=workspace.conversations.find(row=>row.botId===botId)??await api('/bot-instances',{botId});
  const query=new URLSearchParams();
  if(studentId)query.set('student',studentId);
  if(enrollmentId)query.set('enrollment',enrollmentId);
  if(artifactId)query.set('learningArtifact',artifactId);
  routeTo('chat/'+room.id+(query.size?'?'+query:''));
}
