export const builtInCopy = {
  media: {
    description: '有了选题和采访原文，可以把它们写成逐镜口播稿。每一镜都能对照台词、画面、字幕和时长，拍之前还可以继续改。',
    input: '选题、目标观众、预估时长及可引用的文字材料',
    output: '带台词、画面建议、字幕和时间码的分镜稿'
  },
  brief: {
    description: '手上有几份采访或笔记时，把它们放在一起读。简报会列出共同点、不同说法和待核实的问题，每个要点都能回查原句。',
    input: '2–6 份可引用的文字材料，可粘贴或上传 TXT、Markdown',
    output: '附原文引用的简报，可导出 Markdown'
  }
};

const mediaSpecs=[
  ['account','账号分析','diagnose','text',
    '想知道账号接下来该改哪里？从几条代表作品入手，结合播放和互动数据，找出最值得先试的一项调整。',
    '账号面向谁、代表作品和同一时段的数据','账号诊断、判断依据和调整建议'],
  ['benchmark','对标拆解','diagnose','text',
    '把自己的作品和想参考的账号放在一起，比较选题、开头和内容安排，挑出下条视频可以借鉴的做法。',
    '对标账号与你自己的作品样本、观察或数据','差异对照和可尝试的做法'],
  ['topics','选题策划','topics','text',
    '还没决定下一条拍什么？说说观众是谁、最近在问什么，从几个备选题里挑一个，并看看各自为什么值得拍。',
    '账号方向、目标观众和手头的选题线索','备选题目、切入角度和选择理由'],
  ['full','制作流程','full','intake',
    '准备做一条视频，但不知道从哪一步开始？列出手头的稿件和素材，看看现在能做什么、接下来还要补什么。',
    '想做的视频和已经准备好的材料','制作步骤和建议的起点'],
  ['auto-edit','自动剪辑','edit','cut',
    '要先看一版粗剪时，用它从每段视频开头截取指定长度，再按上传顺序拼成一条片子。',
    '按播放顺序排列的视频、每段时长和画幅','粗剪视频（MP4）和镜头时间轴'],
  ['timeline','多素材时间轴','edit','cut',
    '视频中间想穿插照片时，按播放顺序把两类素材放进来，先看一版连起来的效果。',
    '按顺序排列的视频或图片、每段时长','混排成片（MP4）和镜头时间轴'],
  ['transcript','语音转录','edit','asr',
    '把采访录音或视频里的讲话转成文字，方便找原句、整理笔记或准备改稿。',
    '一段声音清楚的录音或视频，需本机语音模型','可在对话中查看的逐字稿'],
  ['captions','字幕与口播剪辑','edit','captions',
    '口播已经拍好，用它识别讲话、生成字幕，拿到视频和可继续校对的字幕文件。',
    '有清晰人声的口播视频，需本机语音模型','剪辑后的视频（MP4）和字幕（SRT）'],
  ['visual','配图、重点字幕与画面提示','edit','visual',
    '讲到重点时，想让观众看哪儿？指出要强调的句子或画面位置，可再附上一张配图，做成带提示的视频。',
    '口播视频、要强调的内容及位置，配图可选，需本机语音模型','带画面提示的视频（MP4）和字幕（SRT）'],
  ['templates','行业模板剪辑','edit','template',
    '同一类口播想用相近的剪法时，写明行业、拍摄限制和希望突出的内容，按模板做出一版成片。',
    '口播视频、所属行业和剪辑要求，需本机语音模型','按模板剪辑的视频（MP4）和字幕（SRT）'],
  ['recipe','自定义剪辑方案','edit','recipe',
    '如果经常拍同类视频，可以先把自己的剪辑习惯整理成规则，检查工作台能否执行，再决定怎么剪。',
    '视频类型、观看目的和你想保留的剪辑习惯','经过工作台校验的剪辑方案'],
  ['advanced','高级口播','edit','advanced',
    '已经录好主讲和补充镜头时，说明每段用来讲什么，按讲解顺序把它们编成一版口播成片。',
    '已有口播视频、补充镜头和各镜头用途','口播成片（MP4）和镜头时间轴'],
  ['transitions','镜头转场','edit','transition',
    '两个镜头硬切显得生硬时，让前一个画面逐渐淡出、后一个接进来，预览衔接后的效果。',
    '至少两段按顺序排列的视频或图片','带淡化转场的成片（MP4）'],
  ['masks','蒙版与遮罩','edit','mask',
    '想保留主画面，同时露出另一段素材？第一份做底图，第二份裁成椭圆小窗叠在右上角。',
    '两份视频或图片，先放底图，再放叠加素材','带固定位置画中画的成片（MP4）'],
  ['music','音乐卡点','edit','onsets',
    '想让换镜头跟上音乐重音？它会标出声音突然变强的时刻，你可以按秒数试听，再挑剪辑点。',
    '一段音乐，或带音乐的视频','候选剪辑点的时间、强度和可下载的 CSV 表'],
  ['motion','画面特效与动效','edit','motion',
    '静止画面也可以有节奏。说清哪一段、哪个位置要动，例如让开场画面慢慢推近，再查看导出效果。',
    '视频或图片、要加效果的位置和预期动作','带动效的成片（MP4）和镜头时间轴'],
  ['shots','镜头库与解释图解','edit','shot',
    '一段话难以拍清楚时，把步骤或关系写出来，做成可插入口播视频的图解镜头。',
    '要解释的文字、步骤或关系，参考图可选','可下载、可用于剪辑的图解镜头（MP4）'],
  ['lighting','布光与灯位','lighting','lighting',
    '拍摄前先试摆灯位。提供场地照片，再说明窗户、人物和现有灯具的位置，取得三档方案供现场试拍。',
    '场地照片、实际空间和手头灯具的说明','三档布光建议和试拍方案'],
  ['publish','发布准备','publish','text',
    '发视频前，把稿件和目标平台交给它，准备发布文案，逐项检查材料授权和发布前要确认的事项。',
    '目标平台、稿件、素材使用权限说明','发布文案和发布前核对清单'],
  ['review','发布复盘','review','text',
    '视频发出后，把表现和原先预期放在一起看。用已有的数据判断下条视频该保留什么、试着改什么。',
    '发布内容、原始数据、统计时段和采集时间（含时区）','有数据依据的复盘和下一轮测试建议']
];
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
    '按学员或课程段查看到期情况，记录联系结果和备注，并从学员档案回看跟进历史。',
    '已登记的课程段或导入的续费记录、联系日期和结果','到期情况和逐次跟进记录'],
  ['history','运营数据导入','operations',
    '续费名单或历史结果放在表格里时，可以一次导入。先核对 CSV 的内容，再确认写入工作台。',
    '符合导入列格式的续费名单或历史结果 CSV','导入条数及可回看的运营记录'],
  ['students','学员档案','students',
    '按姓名查找学员，查看班级、课程和在读状态，也能接着看这个学员以往的学习和跟进记录。',
    '已获授权的学员姓名、班级和课程信息','可查找、可更新的学员档案'],
  ['enrollments','课程段关联','students',
    '为学员新建课程段，或关联已有课程段。关联有误时可解除，再选择正确的学员。',
    '已有学员档案、课程段信息或已导入的课程段','记录在学员档案里的课程关联'],
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
const teachingBots=teachingSpecs.map(([key,name,target,description,input,output])=>({
  id:'teaching-'+key,avatar:'/media/avatars/teaching-'+key+'.webp',name,target,input,output,subcategory:categories[key],kind:'teaching',category:'英语教培',
  revision:1,status:'enabled',subtitle:'内置英语教培',description,exampleTitle:null
}));
const mediaCategories={
  account:'账号',benchmark:'账号',topics:'文案',publish:'文案',review:'数据分析',lighting:'拍摄与制作',full:'拍摄与制作',shots:'拍摄与制作'
};
const modelModes=new Set(['text','visual','template','recipe','advanced','motion','shot','lighting']);
const uploadsModes=new Set(['text','cut','asr','captions','visual','template','advanced','transition','mask','onsets','motion','shot','lighting','intake']);

const mediaBots=mediaSpecs.map(([key,name,intent,mode,description,input,output])=>({
  id:'media-'+key,avatar:'/media/avatars/media-'+key+'.webp',name,intent,mode,input,output,subcategory:mediaCategories[key]??'剪辑',kind:'workbench',category:'自媒体',revision:1,status:'enabled',
  subtitle:'Self Media Workbench',description,exampleTitle:null,
  uploads:uploadsModes.has(mode),model:modelModes.has(mode)
}));
const bots=[...mediaBots,...teachingBots];
const byId=new Map(bots.map(bot=>[bot.id,bot]));
export const specialistBot=(id,revision)=>revision===1?byId.get(id):undefined;

function teachingBlocked(config,bot) {
  if(config.teachingAccess==='teacher')return '';
  if(bot.target==='bot')return config.key?'':'请配置 DeepSeek 模型凭据。';
  if(!config.teaching?.ok)return config.teaching?.reason||'内置英语教培组件未就绪。';
  if(['classroom','practice'].includes(bot.target)&&!config.teaching.lessons.ok)return '教材生成依赖未就绪。'+config.teaching.lessons.reason;
  return '';
}

function mediaBlocked(config,bot) {
  if(!config.workbench?.ok)return config.workbench?.reason||'需要登记 Self Media Workbench。';
  if(bot.model&&!config.dshWeb)return '需要安装锁定的 DSH Web Host 运行时。';
  if(bot.model&&!config.key)return '需要配置 DeepSeek 模型凭据。';
  return '';
}

export function specialistDirectory(config) {
  return bots.map(bot=>bot.kind==='teaching'
    ? {...bot,trial:config.teachingAccess!=='teacher',blocked:teachingBlocked(config,bot)}
    : {...bot,blocked:mediaBlocked(config,bot)});
}
