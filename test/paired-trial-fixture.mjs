import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const interview='访谈.md', filming='拍摄笔记.md';
const definitions=[
  {id:'A', title:'修表摊开张', speaker:'摊主', unknown:'营业时间与经营年限',
    quote:'我每天先铺好垫布，再打开工具盒。',
    revisionVisual:'用桌面近景拍盒盖合拢，留两秒同期声。',
    shots:[
      ['铺垫布','“我每天先铺好垫布，再打开工具盒。”修表摊的准备，就从这张桌子开始。','近拍手把垫布铺平。','先铺好垫布',interview,'我每天先铺好垫布，再打开工具盒。'],
      ['开工具盒','垫布放平，工具盒才打开。镜头不用离开桌面，跟着摊主的手，先看垫布，再看掀开的盒盖。','接掀开工具盒的近景。','再打开工具盒',filming,'先拍手把垫布铺平，然后拍掀开的工具盒。'],
      ['摆工具','台灯挪到工作垫旁。镊子和表带针摆在同一边。先给工作垫一个近景，再接这两件工具的位置。','拍台灯下的镊子和表带针。','镊子和表带针',interview,'摊主把台灯挪到工作垫旁，再把镊子和表带针摆在同一边。'],
      ['收盒盖','顾客到来前，摊主轻轻合上工具盒，留出桌面。口播到这里停一下，听听这一声盒盖合拢。','用桌面近景录下盒盖合拢声。','听一声盒盖合拢',interview,'顾客到来前，摊主会把工具盒轻轻合上，留出桌面。']
    ]},
  {id:'B',title:'社区花房开门',speaker:'志愿者',unknown:'开放时段与运营年限',
    quote:'我每天先把门垫放平，再去开窗。',
    revisionVisual:'用窗台近景拍水壶归位，留两秒同期声。',
    shots:[
      ['放门垫','“我每天先把门垫放平，再去开窗。”花房开门前的准备，从志愿者手里的门垫开始。','近拍志愿者把门垫放平。','先把门垫放平',interview,'我每天先把门垫放平，再去开窗。'],
      ['开窗','门垫放平了，再来拍窗。让镜头顺着志愿者的手，从门口接到拉开的窗，两步都留在画面里。','接一镜志愿者拉开窗。','接着去开窗',filming,'先拍手把门垫放平，然后拍拉开的窗。'],
      ['挪叶片','窗开了，志愿者把叶片移到通风的一侧，再把水壶归到窗边。我们走近一点，给挪动的叶片留个画面。','近拍移到通风处的盆栽叶片。','叶片移到通风的一侧',interview,'开窗后，志愿者把叶片移到通风的一侧，再把水壶归到窗边。'],
      ['水壶归位','等准备完毕，水壶底轻轻碰一下窗台。末镜的口播停下来，让水壶归位的真实声音收尾。','用窗台近景录下水壶归位声。','听一声水壶归位',interview,'准备完毕时，水壶底会轻轻碰一下窗台。']
    ]}
];

export const normalize = text => text.replaceAll('\r\n','\n').trim();

export async function loadTrialTasks(directory) {
  return Promise.all(definitions.map(async task=>{
    const files=await Promise.all([interview,filming].map(async name=>({
      name,content:normalize(await readFile(path.join(directory,task.id,name),'utf8'))
    })));
    const label='试用任务 '+task.id+' · '+task.title;
    const prompt=label+'。按两份合成材料写约 45 秒的中文口播分镜，共四镜。用'+task.speaker+
      '的完整原话开场。给每镜的时间码、口播、画面、字幕和逐字引用。结尾留真实动作声。'+
      '未得到依据的事实放入待确认，时间写作估算。只需口播环节。';
    const revise=label+'。基于原项目首稿只改最后一镜的画面说明，明确留两秒同期声。保持其余镜头及时间码，保存为新版本。';
    for (const [, , , ,file,quote] of task.shots) assert.ok(files.find(row=>row.name===file)?.content.includes(quote));
    return {...task,label,prompt,revise,files};
  }));
}

export function matchTrialSource(task,source) {
  if (typeof source?.content!=='string') return undefined;
  return task.files.find(file=>normalize(source.content)===file.content);
}

export function trialScript(task,sources,revision) {
  const ids=new Map();
  for (const source of sources) {
    const file=matchTrialSource(task,source);
    if (file) ids.set(file.name,source.id);
  }
  assert.equal(ids.size,2,'Workbench or prompt must carry both exact input texts');
  const cuts=[0,8,19,33,45];
  return {title:task.title+'的 45 秒口播',segments:task.shots.map(([name,spoken,visual,subtitle,file,quote],index)=>({
    name,start:cuts[index],end:cuts[index+1],spoken,visual:revision&&index===3?task.revisionVisual:visual,
    subtitle,evidence:[{material:ids.get(file),quote}]
  })),notes:['待确认'+task.unknown]};
}

export function trialSubmission(context,result,request) {
  const claims=result.segments.map((row,index)=>({id:'claim-'+(index+1),text:row.spoken,kind:'observation',
    evidence:row.evidence.map(ref=>({source_id:ref.material,quote:ref.quote})),limitation:'两份合成试用材料，待读审。'}));
  return {request_id:randomUUID(),revision:context.project.revision,context_id:context.context_id,
    stage:'script',input_artifact_ids:[],standalone_reason:'给定方向，单独试用口播分镜。',
    payload:{topic_artifact_id:null,topic_id:null,claims,
      segments:result.segments.map(({name,evidence,...segment},index)=>({...segment,id:'segment-'+(index+1),claim_ids:[claims[index].id]})),
      cta:'',production_limits:['时长为估算。',...result.notes]},
    declared_status:'needs_review',unresolved:result.notes,supersedes:context.heads.script??null,
    revision_reason:context.heads.script?request:null};
}
