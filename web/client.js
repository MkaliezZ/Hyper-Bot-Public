const workspacePath = /^\/w\/([0-9a-f-]{36})\/$/.exec(location.pathname)?.[1];
export const currentWorkspace = workspacePath ?? 'personal';
const workspaceIndex = '/v1/workspaces';
export const apiPath = route => '/api'+(workspacePath && route!==workspaceIndex ? workspaceIndex+'/'+workspacePath : '')+route;
const lastConversationKey = id => 'hyper-bot:last-conversation:'+id;
export function workspaceHref(id) {
  let last='';
  try {last=localStorage.getItem(lastConversationKey(id))??'';} catch { /* Navigation works without local storage. */ }
  return (id==='personal'?'/':'/w/'+id+'/')+(/^chat\/[0-9a-f-]{36}$/.test(last)?'#'+last : '#home');
}
export function rememberConversation(id) {
  try {localStorage.setItem(lastConversationKey(currentWorkspace),'chat/'+id);} catch { /* Optional on this device. */ }
}
export async function api(route, body, options = {}) {
  const response = await fetch(apiPath(route), {
    ...options, cache:'no-store',
    ...(body===undefined ? {} : {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Hyper-Bot':'1'},
      body:JSON.stringify(body)
    })
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? '操作未完成。');
    error.code = data.code;
    throw error;
  }
  return data;
}
export const clock = stamp => new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(stamp));
export const day = stamp => new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(new Date(stamp));
export const seconds = value => String(Math.round(value * 100) / 100).padStart(value<10?2:0,'0');
export const phases = {
  queued:'已排队',running:'生成中',recovering:'正在找回结果',waiting_approval:'待确认写入',saving:'正在写入',
  stopping:'正在停止',succeeded:'已完成',failed:'任务失败',cancelled:'已停止',interrupted:'已中断'
};
export const runPhase = run => run.returnedForRevision?'已退回改稿':
  run.stop?.outcome==='unconfirmed'?'停止未确认':phases[run.state];
export const routeTo = path => {location.hash=path;};
export const artifactHref = record => '#chat/'+record.conversation+'?artifact='+record.id;
export const runHref = run => '#chat/'+run.conversation+'?run='+run.id;
export const needsReassembly = bot => bot.harnessChanged || bot.workflowChanged || bot.skillRevoked;
export function dependencyHref(bot,room) {
  const params=new URLSearchParams({bot:bot.id,revision:bot.revision});
  if(room)params.set('room',room);
  return (needsReassembly(bot)?'#manage?':'#manage/dependencies?')+params.toString();
}

export function downloadFile(blob,filename) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=filename;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}

export function browseHref(page,{bot='',revision='',q=''}={}) {
  const parameters=new URLSearchParams();
  if (bot) {
    parameters.set('bot',bot);
    if (revision) parameters.set('revision',revision);
  }
  if (q) parameters.set('q',q);
  return '#'+page+(parameters.size?'?'+parameters.toString():'');
}

