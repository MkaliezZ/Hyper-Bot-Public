import {apiPath,currentWorkspace} from './client.js';

const sessionKey='hyper-bot:teaching-session:'+currentWorkspace;
export function teacherSession(value) {
  if(value===null)sessionStorage.removeItem(sessionKey);
  else if(value!==undefined)sessionStorage.setItem(sessionKey,value);
  return sessionStorage.getItem(sessionKey);
}
export async function teachingRequest(room,action,{body,signal,file,blob}={}) {
  const headers={'X-Hyper-Teaching':teacherSession()??'','X-Hyper-Bot':'1'};
  let payload;
  if(file){payload=new FormData();payload.append('file',file);}
  else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
  const response=await fetch(apiPath('/rooms/'+room+'/teaching/'+action),{
    method:payload===undefined?'GET':'POST',headers,body:payload,signal,cache:'no-store'
  });
  if(!response.ok) {
    const result=await response.json().catch(()=>({}));
    if(response.status===401&&action!=='login'&&headers['X-Hyper-Teaching']===teacherSession()){
      teacherSession(null);window.dispatchEvent(new Event('teaching-expired'));
    }
    throw new Error(result.error??'暂时无法连接英语教培工作台。');
  }
  return blob?response.blob():response.json();
}
