const teachingSpecs=[
  ['classroom','课上互动课件','classroom',
    '把一段英语教材变成课堂活动。可以直接预览、试答互动题，也可以下载课件带去上课。',
    '教材文件、授课目标，可指定页码','可试答的网页课件（HTML）和演示课件（PPTX）'],
  ['practice','课后练习设计','practice',
    '用刚教过的内容出一份练习。先确认要考的知识点，再分别查看给学生的题目和给老师的参考答案。',
    '单元材料、练习目标和选定的知识点','学生练习单和教师参考版'],
  ['calendar','运营校历','operations',
    '把开班、活动或考试放进校历，设置提前多少天提醒。每年重复的安排只需登记一次。',
    '事项名称、日期、适用课程和提醒天数','可查看和更新的校历日程'],
  ['signals','政策与热点','operations',
    '收到政策通知或考试消息时，把原文链接和影响范围记在一起，标明哪些内容已经核实。',
    '来源链接、发布日期、地区和内容摘要','带来源、核验状态和备注的线索记录'],
  ['renewals','续费与跟进','operations',
    '查看哪些课程快到期了。联系家长后记下结果和备注，下次跟进时可以接着上次的记录。',
    '已导入的续费名单、联系日期和结果','到期情况和逐次跟进记录'],
  ['history','运营数据导入','operations',
    '续费名单或历史结果放在表格里时，可以一次导入。先核对 CSV 的内容，再确认写入工作台。',
    '符合导入列格式的续费名单或历史结果 CSV','导入条数及可回看的运营记录'],
  ['students','学员档案','students',
    '按姓名查找学员，查看班级、课程和在读状态，也能接着看这个学员以往的学习和跟进记录。',
    '已获授权的学员姓名、班级和课程信息','可查找、可更新的学员档案'],
  ['enrollments','课程段关联','students',
    '把某一期课程挂到对应学员名下。关联有误时也可以解除，重新选择正确的学员和课程。',
    '已有学员档案和已登记的课程段','记录在学员档案里的课程关联'],
  ['learning','学习记录','students',
    '这位学员用过哪份课件、哪份练习已经完成？把材料、日期和进度记在一起，下次备课时可查。',
    '学员、已有课件或练习，以及实际学习进度','带日期、材料和备注的学习记录'],
  ['bot','教培任务助手','bot',
    '临时要解释一个语法点、想一道例题或改一句课堂指令时，写明学生水平和问题，拿到一份可继续修改的答复。',
    '教培问题、学生水平，或要参考的材料','可查看和保存的文字答复']
];

const categories={
  classroom:'课前',practice:'课后',calendar:'运营',signals:'运营',renewals:'运营',history:'运营',
  students:'管理',enrollments:'管理',learning:'管理',bot:'教学支持'
};
const bots=teachingSpecs.map(([key,name,target,description,input,output])=>({
  id:'teaching-'+key,name,target,input,output,subcategory:categories[key],kind:'teaching',category:'英语教培',
  revision:1,status:'enabled',subtitle:'内置英语教培',description,exampleTitle:null
}));
const byId=new Map(bots.map(bot=>[bot.id,bot]));
export const teachingBot=(id,revision)=>revision===1?byId.get(id):undefined;

function blocked(config,bot) {
  if(config.teachingAccess==='teacher')return '';
  if(bot.target==='bot')return config.key?'':'请配置 DeepSeek 模型凭据。';
  if(!config.teaching?.ok)return config.teaching?.reason||'内置英语教培组件未就绪。';
  if(['classroom','practice'].includes(bot.target)&&!config.teaching.lessons.ok)return '教材生成依赖未就绪。'+config.teaching.lessons.reason;
  return '';
}

export function teachingDirectory(config) {
  return bots.map(bot=>({...bot,trial:config.teachingAccess!=='teacher',blocked:blocked(config,bot)}));
}
