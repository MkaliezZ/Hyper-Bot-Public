import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { id, Problem } from './contracts.mjs';
import { botOf, conversationOf } from './store.mjs';
import { jsonBody } from './provider.mjs';

const expired=()=>new Problem(401,'请使用原工作台的教师账号登录。','teaching_session');
const missing=()=>new Problem(404,'当前教培会话没有这项内容。','teaching_scope');
const duration=4*60*60*1000;
const mediaLimit=33*1024*1024;
const resourceId=value=>id.parse(value);
const loginInput=z.strictObject({password:z.string().min(1).max(100)});
const tracks=z.enum(['k12','toefl','ielts']);

async function business({request,response,url,bot,action,json,auth,data,input}) {
  const area=bot.id.slice('teaching-'.length);
  const students=bot.target==='students';
  if(request.method==='GET'&&action==='records') {
    const route=students?'/students?q='+encodeURIComponent((url.searchParams.get('q')??'').slice(0,80)):'/operations';
    const result=await data('GET',route,{auth});
    if(students)return json(response,{students:result.students,
      ...(area==='enrollments'?{enrollments:result.enrollments}:{}),...(area==='learning'?{artifacts:result.artifacts}:{})});
    if(area==='renewals')return json(response,{renewals:result.renewals,followUps:result.followUps});
    return json(response,{[area]:result[area]});
  }
  if(request.method==='GET'&&students&&action==='detail') {
    return json(response,await data('GET','/students/'+id.parse(url.searchParams.get('id')),{auth}));
  }
  if(request.method!=='POST'||action!=='record-write')throw missing();
  const body=z.strictObject({action:z.string(),key:id,record:z.string().max(64),input:z.record(z.string(),z.unknown())}).parse(await input());
  let route;
  if(area==='calendar'&&body.action==='calendar')route='/operations/calendar';
  if(area==='signals'&&['signals','refresh'].includes(body.action))route='/operations/signals'+(body.action==='refresh'?'/refresh':'');
  if(area==='history'&&['renewalImport','historyImport'].includes(body.action))route=body.action==='renewalImport'?'/operations/renewals/import':'/operations/history/import';
  if(area==='renewals'&&body.action==='renewals'){
    const enrollment=z.string().regex(/^[a-z\d][a-z\d_-]{0,63}$/i).parse(body.record);
    route='/operations/renewals/'+enrollment+'/follow-up';
  }
  if(area==='students'&&body.action==='students')route='/students'+(body.record?'/'+id.parse(body.record):'');
  if(area==='enrollments'&&['link','unlink'].includes(body.action))route='/students/'+id.parse(body.record)+'/enrollments'+(body.action==='unlink'?'/unlink':'');
  if(area==='learning'&&body.action==='learning')route='/students/'+id.parse(body.record)+'/learning-links';
  if(!route)throw missing();
  const output=await data('POST',route,{auth,key:body.key,body:body.input});
  return json(response,output);
}

export function teachingWorkbench(env=process.env,trialPassword,bridgeKey) {
  const port=Number(env.HYPER_BOT_TEACHING_PORT||8443);
  const cert=env.HYPER_BOT_TEACHING_CA||(env.M0_DATA&&path.join(env.M0_DATA,'localhost.crt'));
  const origin=(bridgeKey?'http':'https')+'://127.0.0.1:'+port;
  const transport=bridgeKey?http:https;
  const unavailable=()=>new Problem(503,bridgeKey?'内置教培组件暂时无法连接，请重新连接。':
    '无法连接英语教培工作台，请检查本机 HTTPS 服务、证书与端口。','teaching_unavailable');
  const sessions=new Map(), previews=new Map(), binding=new Set();

  async function upstream(method,route,{auth,body,upload,key}={}) {
    if(!Number.isInteger(port)||port<1024||port>65535)throw unavailable();
    const headers={Origin:origin};
    if(bridgeKey)headers['X-Hyper-Bot-Teaching-Bridge']=bridgeKey;
    if(auth)Object.assign(headers,{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf});
    if(key)headers['Idempotency-Key']=resourceId(key);
    const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    if(upload) {
      const size=Number(upload.headers['content-length']);
      if(!Number.isSafeInteger(size)||size<=0||size>mediaLimit)throw new Problem(413,'教材上传上限为 32 MiB。');
      headers['Content-Type']=upload.headers['content-type'];
      headers['Content-Length']=size;
    }
    let res;
    try {
      const ca=bridgeKey?undefined:cert?await readFile(cert):await readFile(new URL('../.hyper-bot/teaching-ca.crt',import.meta.url)).catch(error=>{
        if(error.code!=='ENOENT')throw error;
      });
      res=await new Promise((resolve,reject)=>{
        const req=transport.request(origin+'/api/v1'+route,{method,headers,ca,timeout:45000},resolve);
        req.on('timeout',()=>req.destroy(new Error('timeout')));
        req.on('error',reject);
        if(upload) pipeline(upload,req).catch(reject);
        else req.end(bytes);
      });
    } catch {throw unavailable();}
    if(res.statusCode>=200&&res.statusCode<300)return res;
    let detail='';
    for await(const chunk of res)if(detail.length<4096)detail+=chunk;
    let reason;try{reason=JSON.parse(detail).error;}catch{}
    throw new Problem(res.statusCode,'英语教培工作台：'+(typeof reason==='string'?reason:'请求未完成。'),
      res.statusCode===401?'teaching_session':'teaching_request');
  }
  async function data(method,route,options) {
    const res=await upstream(method,route,options);
    const chunks=[];for await(const chunk of res)chunks.push(chunk);
    return chunks.length?JSON.parse(Buffer.concat(chunks)):null;
  }
  function prune() {
    for(const map of [sessions,previews])for(const [key,value] of map)if(value.expires<=Date.now())map.delete(key);
  }
  async function session(request) {
    prune();
    const auth=sessions.get(request.headers['x-hyper-teaching']);
    if(!auth)throw expired();
    return auth;
  }
  async function render(request,response,ticket) {
    prune();
    const item=previews.get(ticket);
    const auth=item&&sessions.get(item.token);
    if(!auth||request.method!=='GET'||!request.headers.cookie?.split(';').some(cookie=>cookie.trim()===auth.previewCookie))throw missing();
    const res=await upstream('GET',item.route,{auth});
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':res.headers['content-security-policy']});
    await pipeline(res,response);
  }
  async function handle(request,response,url,host,roomId,action,json) {
    const state=host.store.read();
    const room=conversationOf(state,resourceId(roomId));
    const bot=botOf(state,room.botId,room.revision);
    if(bot?.kind!=='teaching')throw missing();
    const target=bot.target, method=request.method, post=method==='POST';
    const input=()=>jsonBody(request);
    if((action==='login'&&!trialPassword||action==='trial'&&trialPassword)&&post) {
      prune();
      const body=trialPassword?{password:await trialPassword()}:loginInput.parse(await input());
      const res=await upstream('POST','/session',{body:{account:'teacher',password:body.password}});
      const cookie=res.headers['set-cookie']?.[0]?.match(/^m0_session=[a-f0-9]{64}(?=;)/)?.[0];
      const chunks=[];for await(const chunk of res)chunks.push(chunk);
      const {account,csrf_token:csrf}=JSON.parse(Buffer.concat(chunks));
      if(!cookie||account!=='teacher'||typeof csrf!=='string')throw unavailable();
      const token=randomUUID();
      const previewCookie='hb-teaching-'+randomUUID()+'='+randomUUID();
      sessions.set(token,{cookie,account,csrf,previewCookie,expires:Date.now()+duration});
      response.setHeader('Set-Cookie',previewCookie+'; HttpOnly; SameSite=Strict; Path=/teaching-preview/; Max-Age=14400');
      return json(response,{token,account});
    }
    const auth=await session(request);
    if(action==='logout'&&post) {
      try{await data('POST','/session/end',{auth,body:{}});}
      finally{
        sessions.delete(request.headers['x-hyper-teaching']);
        response.setHeader('Set-Cookie',auth.previewCookie.split('=')[0]+'=; HttpOnly; SameSite=Strict; Path=/teaching-preview/; Max-Age=0');
      }
      return json(response,{});
    }
    if(action==='context'&&!post) {
      const context=await data('GET','/context',{auth});
      return json(response,{account:context.account});
    }
    if(['operations','students'].includes(target)){
      return business({request,response,url,bot,action,json,auth,data,input});
    }
    const owned=new Set(room.teachingTaskIds??[]);
    if(target==='bot'&&action==='connection'&&!post) {
      const context=await data('GET','/bot/context',{auth});
      return json(response,{title:context.title,connection:context.connection,messages:context.messages.filter(row=>owned.has(row.taskId))});
    }
    if(!['classroom','practice','bot'].includes(target))throw missing();
    const projectField=trialPassword?'trialTeachingProject':'teachingProject';
    const attached=room[projectField];
    const loadProject=async key=>{
      const project=await data('GET','/projects/'+resourceId(key),{auth});
      if(project.module!==target)throw missing();
      return target==='bot'?{...project,tasks:project.tasks.filter(task=>owned.has(task.task_id)),task_count:owned.size}:project;
    };
    if(action==='projects'&&!post)return json(response,target==='bot'?[]:await data('GET','/projects?module='+target,{auth}));
    if(action==='bind'&&post) {
      const body=z.strictObject({project:id.optional(),track:tracks.optional(),title:z.string().trim().min(1).max(100).optional()}).parse(await input());
      if(attached)return json(response,await loadProject(attached));
      if(binding.has(room.id))throw new Problem(409,'项目正在连接，请稍后刷新。');
      binding.add(room.id);
      try {
        const current=conversationOf(host.store.read(),room.id)[projectField];
        if(current)return json(response,await loadProject(current));
        const project=body.project?await loadProject(body.project):await data('POST','/projects',{auth,body:{
          module:target,title:body.title||room.title,...(target==='classroom'?{track:body.track||'k12'}:{})}});
        host.store.change(state=>{conversationOf(state,room.id)[projectField]=resourceId(project.id);});
        return json(response,project);
      } finally{binding.delete(room.id);}
    }
    if(action==='project'&&!attached&&!post){await data('GET','/context',{auth});return json(response,null);}
    if(!attached)throw new Problem(409,'请先选择或建立教培项目。');
    const project=await loadProject(attached);
    if(action==='project'&&!post)return json(response,project);
    if(action==='upload'&&post&&target!=='bot')return json(response,await data('POST','/assets?project_id='+attached,{auth,upload:request}),201);
    if(action==='submit'&&post) {
      const body=z.strictObject({action:z.enum(['generate_lesson','identify_learning_targets','design_practice_pack','ask_bot']),
        input:z.record(z.string(),z.unknown()),assets:z.array(id).max(1),key:id}).parse(await input());
      const receipt=await data('POST','/tasks',{auth,key:body.key,body:{module:target,project_id:attached,
        action:body.action,input:body.input,asset_ids:body.assets}});
      if(target==='bot')host.store.change(state=>{
        const current=conversationOf(state,room.id);
        const ids=current.teachingTaskIds??=[];
        const task=resourceId(receipt.task_id);
        if(!ids.includes(task))ids.push(task);
      });
      return json(response,receipt,202);
    }
    const artifact=resourceId(url.searchParams.get('id'));
    if(!project.tasks.some(task=>task.artifact_ids.includes(artifact)))throw missing();
    const route='/artifacts/'+artifact;
    if(action==='artifact'&&!post)return json(response,await data('GET',route,{auth}));
    const format=url.searchParams.get('format');
    if(action==='preview'&&post) {
      if(!['lesson','student','teacher'].includes(format))throw missing();
      const ticket=randomUUID();
      previews.set(ticket,{token:request.headers['x-hyper-teaching'],route:route+'/preview'+(format==='lesson'?'':'?format='+format),expires:Date.now()+5*60*1000});
      return json(response,{url:'/teaching-preview/'+ticket});
    }
    if(action==='download'&&!post&&['pptx','html','student','teacher'].includes(format)) {
      const res=await upstream('GET',route+'/download?format='+format,{auth});
      response.writeHead(200,{'Cache-Control':'no-store','Content-Type':'application/octet-stream','Content-Disposition':'attachment'});
      return pipeline(res,response);
    }
    throw missing();
  }
  return {handle,render,hasPreview:ticket=>previews.has(ticket)};
}
