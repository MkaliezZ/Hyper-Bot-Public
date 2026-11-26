"""Practice templates with source evidence and separate teacher instructions."""

from dataclasses import dataclass, field
from hashlib import sha256
import re

from practice_material import WORD
from practice_visual import Visual


@dataclass
class Exercise:
    target: dict
    prompt: str
    materials: list[str]
    fields: list[str]
    answer: str
    hint: str
    teacher_preparation: str = ''
    extra_note: str = ''
    choices: list[str] = field(default_factory=list)
    panels: list[str] = field(default_factory=list)
    visuals: list[Visual] = field(default_factory=list)
    heading: str = ''


TEACHER_AUDIO = '请先录制或朗读下列短音频，再给学生作答。首次作答前只播放，不发文字稿。'
TEACHER_SCENE = '以下为围绕教材用法编写的原创场景。'
TIMING = {'deadline', 'date', 'clock'}
CONNECTIONS = {'conditional', 'cause', 'order', 'comparison'}
SCHOOL_PLANNING = TIMING | {'conditional'}
WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


def quoted(target):
    return f'教材片段 · {target["locator"]}\n{target["evidence"]}'


def changed_day(value):
    return next((
        day for day in WEEKDAYS if re.search(rf'\b{day}\b', value, re.I)
    ), None)


def substitute(text, value, replacement):
    return re.sub(r'(?<!\w)' + re.escape(value) + r'(?!\w)', lambda m: replacement(m.group()), text, flags=re.I)


def decoys(target):
    value = target['value']
    if target['kind'] in TIMING:
        preposition, limit = value.split(' ', 1)
        return [f'{other} {limit}' for other in ('by', 'on', 'at') if other != preposition.lower()]
    day = changed_day(value)
    if day:
        position = WEEKDAYS.index(day)
        return [value.replace(day, WEEKDAYS[(position + offset) % 7]) for offset in (1, 2)]
    if value.isdigit():
        return [str(int(value) + i) for i in (3, 7)]
    if target['kind'] == 'direction':
        return [direction for direction in ('turn left', 'turn right', 'go straight') if direction != value.lower()][:2]
    if target['kind'] == 'comparison':
        return [phrase for phrase in ('less than', 'more than', 'as many as') if phrase != value.lower()][:2]
    return []


def single_choice(target, context):
    value = target['value']
    fake = decoys(target)
    if len(fake) < 2:
        value = WORD.findall(value)[0]
        fake = list(dict.fromkeys(word for word in WORD.findall(target['evidence']) if
                                 word.casefold() != value.casefold() and word.lower() == word))[:2]
    if len(fake) < 2:
        return None
    masked = substitute(target['evidence'], value, lambda _: '____')
    if masked == target['evidence']:
        return None
    choices = [value, *fake]
    offset = sha256(target['evidence'].encode()).digest()[0] % len(choices)
    choices = choices[offset:] + choices[:offset]
    return Exercise(target, '选出教材原句空缺处的表达。', [
        masked,
    ], [], f'答案为 {value}。请对照教材原句核验。', '根据空格在句中的作用回忆原文。', choices=choices)


def short_fill(target, context):
    value = target['value']
    if target['kind'] == 'conditional':
        value = WORD.findall(value)[0]
    elif target['kind'] == 'reading':
        words = [word for word in WORD.findall(value) if len(word) >= 3]
        if not words:
            return None
        value = words[-1]
    words = len(value.split())
    prompt = f'补全教材原句，共 {words} 个词或数字。'
    masked = substitute(target['evidence'], value, lambda _: '____')
    if masked == target['evidence']:
        return None
    if context['difficulty'] == 'guided' and context['sequence'] == 'standard':
        prompt += f' 提示：首字符为 {value[0]}。'
    return Exercise(target, prompt, [masked], ['补全内容'],
                    f'原文为 {value}。大小写按目标和句首位置审阅。', '回想空格前后的词语怎样搭配。')


def judgment_evidence(target, context):
    value = target['value']
    opposite = {
        'turn left': 'turn right', 'turn right': 'turn left', 'more than': 'less than', 'less than': 'more than',
        'before': 'after', 'after': 'before', 'at least': 'at most', 'at most': 'at least',
    }.get(value.casefold())
    day = changed_day(value)
    if target['kind'] in {'deadline', 'date'} and day:
        opposite = re.sub(day, WEEKDAYS[(WEEKDAYS.index(day) + 1) % 7], value, flags=re.I)
    if target['kind'] == 'number' and value.isdigit():
        opposite = str(int(value) + 3)
    statement = substitute(target['evidence'], value, lambda _: opposite) if opposite else ''
    result = '这条改写与所给原句不一致' if opposite else '原句直接支持此说法'
    if not statement:
        statement = f'有人说这段材料明确提到 “{value}”。'
    return Exercise(target, '先判断下面的说法是否得到材料支持，再引用原句。', [quoted(target), f'说法\n{statement}'],
                    ['判断', '原文依据'], f'{result}。有效依据：{target["evidence"]}',
                    '圈出能改变结论的词，如时间、数字或方向。')


def short_response(target, context):
    value = target['value']
    if target['kind'] in SCHOOL_PLANNING:
        task = '给错过消息的同学写 2–3 句英文。传达原文的一条信息，再补一句清楚的提醒。'
        answer = f'第一句准确传达 {value} 所涉及的原文信息。提醒可自编，但不能扭曲原文。'
    else:
        task = '用 2–3 句英语向没读过材料的同学解释片段里的一个观点或细节，写明你引用的是哪句话。'
        answer = '简述准确、原文证据可定位、语言可理解。接受自然的同义写法。'
    return Exercise(target, task, [quoted(target)], ['我的消息', '我参考的原文'], answer,
                    '先写读者最需要知道的一条信息，再检查是否保留原意。')


def editing(target, context):
    value = target['value']
    if target['kind'] == 'deadline' and changed_day(value):
        incorrect = value.replace(value.split(' ')[0], 'on', 1)
        edited = substitute(target['evidence'], value, lambda _: incorrect)
        answer = f'把 {incorrect} 改回 {value}，以保留报名截止的意思。其它信息无须修改。'
    elif target['kind'] == 'conditional' and re.search(r'\bif it rains\b', value, re.I):
        edited = re.sub(r'(\bif it )rains\b', r'\g<1>rain', target['evidence'], count=1, flags=re.I)
        answer = '将 If it rain 修订为 If it rains，保持地点、活动和其它信息。'
    elif decoys(target):
        incorrect = decoys(target)[0]
        edited = substitute(target['evidence'], value, lambda _: incorrect)
        answer = f'将草稿中的 {incorrect} 修订为 {value}，保留其余事实。'
    else:
        last_letters = WORD.findall(target['evidence'])
        relevant = next((word for word in reversed(last_letters) if len(word) > 3), None)
        if not relevant:
            return None
        incorrect = relevant[:-2] + relevant[-1] + relevant[-2]
        if incorrect == relevant:
            incorrect = relevant + relevant[-1]
        edited = substitute(target['evidence'], relevant, lambda _: incorrect)
        answer = f'将草稿中的 {incorrect} 修订为 {relevant}。'
    if edited == target['evidence']:
        return None
    return Exercise(target, '核对教材，把草稿中错误的信息或词形修好。在原句正确的部分保留原意。',
                    [quoted(target), f'待审草稿\n{edited}'], ['我修改的地方', '修订后的句子'],
                    answer, '从最容易改变意思的一词开始比对。')


def sequencing(target, context):
    if target['kind'] != 'order':
        return None
    sentences = [block['text'] for block in context['nearby']]
    ordered = next((lineup for lineup in zip(sentences, sentences[1:], sentences[2:]) if
                    target['evidence'] in lineup
                    and re.match(r'^first\b', lineup[0], re.I)
                    and re.match(r'^(then|next|after that)\b', lineup[1], re.I)
                    and re.match(r'^(finally|in the end)\b', lineup[2], re.I)), None)
    if ordered:
        cards = ['B', 'C', 'A']
        return Exercise(target, '将打散的三张原文句卡排回去，圈出一处有用的顺序线索。',
                        [f'{label}. {ordered[index]}' for label, index in zip(cards, (1, 2, 0))],
                        ['句序', '顺序线索'], 'A → B → C。理由可以使用 First、Then/Next、Finally。',
                        '开头、过渡和结尾分别有什么时间提示？')
    return Exercise(target, '把四张说明句卡排成可执行的步骤，再圈出一个有用的词。', [
        'D. Finally, leave one comment on that poster.',
        'B. Next, bring that photo to your group.',
        'A. First, choose one photo from your visit.',
        'C. After that, add the photo to the class poster.',
    ], ['句卡顺序', '支持这个顺序的词'], 'A → B → C → D。按材料中的顺序结构与指代判定。', '找出 that 各指什么。', TEACHER_SCENE)


def planning(target, context):
    if target['kind'] not in SCHOOL_PLANNING:
        return None
    return Exercise(target, '根据两份英文材料为 Alex 选活动。Alex 周五上午 11 点能提交报名，下午 4:20 才能到校。当天下雨。',
                    ['原创活动表\nFriday Photo Walk: 4:00–4:30 p.m. Sign up by Thursday.\nFriday Poster Workshop: 4:30–5:00 p.m. Meet in Room 2. Sign up by Friday noon.',
                     '更新通知\nIf it rains, the poster workshop will meet in the library.',
                     '可参照的教材表达\n' + quoted(target)],
                    ['活动', '开始时间', '地点', '两份材料的依据'],
                    'Poster Workshop，4:30 p.m.，library。周五 11 点仍在 workshop 报名限期内，且能及时到场。雨天通知要求去图书馆。',
                    '先核对报名截止和到校时间，再看是否有更新。', TEACHER_SCENE)


def branching(target, context):
    if target['kind'] not in SCHOOL_PLANNING | {'direction'}:
        return None
    return Exercise(target, '根据原创便条先用英语询问遗漏信息。收到老师发的回复后，给同学写一句确认。',
                    ['The class visit has moved to the library. Ask your teacher for the new meeting time.',
                     '可以参考教材表达\n' + quoted(target)],
                    ['先问一句', '拿到教师回复再确认'],
                    '第一步需问新集合时间。第二步确认图书馆、4:15 p.m.。接受自然的礼貌请求。',
                    '找出目前还不能确定的信息。',
                    '可将回复单独打印。若问到新时间，回复 “We will meet at 4:15 p.m.”；若只问地点，回复 “The library. What else do you need to know?”')


def relationship_map(target, context):
    if target['kind'] not in CONNECTIONS:
        return None
    answer = '两端都应能在原句中定位，连线方向与关系要匹配。'
    if target['kind'] == 'conditional':
        condition, _, action = target['value'].partition(',')
        answer = f'参考连线：{condition.strip()} → {action.strip()}。从条件指向对应行动。'
    if target['kind'] == 'order':
        return Exercise(target, '找出教材的顺序线索，用箭头标出教材要求的第一步、下一步或最后一步，再写出原文依据。',
                        [quoted(target)], ['线索', '它对应哪一步', '原文依据'],
                        f'应说明 {target["value"]} 的先后作用。对应的动作以教材原句为准。',
                        '区分表示开头、继续和收尾的词。')
    return Exercise(target, '从材料写出两个事件、条件或数量，画箭头指出它们的关系，给箭头写关系名称。也可写成「A → B」。',
                    [quoted(target)], ['A', '箭头代表', 'B'], answer,
                    '先把连接词画线，再检查箭头前后的顺序。')


def route(target, context):
    if target['kind'] != 'direction':
        return None
    return Exercise(target, '按英文指路给新同学画路线，标出按顺序经过的地点。地图上面是北，右边是东。',
                    ['原创校园路网\n北排　图书馆 ─ 实验室 ─ 体育馆\n　　　　│　　　　│　　　　│\n南排　大门　 ─ 办公室 ─ 操场',
                     'Start at the gate, facing east. Go straight past the office. Turn left at the playground. Stop at the next building.',
                     '教材中的指路表达\n' + quoted(target)],
                    ['地点先后顺序', '在什么地标转弯', '到达的地点'],
                    '大门 → 办公室 → 操场，在操场左转向北，终点体育馆。用英文地名也可以。',
                    '先在地图上写下出发时面对的方向。', TEACHER_SCENE)


def rule_discovery(target, context):
    if target['kind'] in TIMING:
        return Exercise(target, '给三条原创例句中的时间短语归类，从例句说明规则，再给虚构活动写一句含截止日的新通知。',
                        [quoted(target), '原创对照\nSign up by Wednesday.\nThe reading club is on Friday.\nMeet at 4 p.m.'],
                        ['截止日', '活动日', '具体钟点', '一句新通知'],
                        'by Wednesday＝最晚日期，on Friday＝活动日，at 4 p.m.＝钟点。新通知需将 by 与合适截止时间搭配。',
                        '把例句分别解释成「最晚」「哪天」「几点」。')
    if target['kind'] == 'conditional':
        return Exercise(target, '从例句找出发生条件和相应行动，再给新活动写一个条件句。',
                        [quoted(target), "原创对照\nIf the hall is busy, we'll meet outside."],
                        ['教材条件', '教材行动', '新的条件与行动'],
                        '能区分条件与其触发的行动。新句如果使用 if/ will 表将来，应避免把 will 放入普通条件从句。',
                        '说出哪件事决定另一件事会不会发生。')
    return None


def rule_flip(target, context):
    value = target['value']
    if target['kind'] == 'deadline' and changed_day(value):
        return Exercise(target, '报名系统周三和周四都开放，哪天提交有效以通知为准。Lia 只能周三提交。改通知中的一个词，让她从能报名变成不能报名。',
                        ['原创通知\nSign up by Thursday.', '教材中的时间条件\n' + quoted(target)],
                        ['改后的通知', '哪一个词使结果改变'],
                        '改成 Sign up on Thursday. 这是指定周四，而原来是最迟周四。',
                        '区分截止日与唯一允许日期。')
    replacement = {'more than': 'fewer than', 'fewer than': 'more than',
                   'at least': 'at most', 'at most': 'at least',
                   'turn left': 'turn right', 'turn right': 'turn left'}.get(value.casefold())
    if replacement:
        return Exercise(target, f'改写表达 {value}，让相应的数量判断或路线改变。写一个原来成立、改后不成立的例子。',
                        [quoted(target)], ['修改后的句子', '翻转的具体例子'],
                        f'参考方向：将 {value} 改为 {replacement}。举的例子必须确实落在改写前后的差异范围内。',
                        '只改变方向或比较关系，保留其余条件。')
    return None


def student_questions(target, context):
    samples = [quoted(target)]
    for block in context['nearby']:
        if context['difficulty'] == 'challenge' and block['text'] != target['evidence'] and block['locator'] == target['locator']:
            samples.append(f'相同位置的另一句\n{block["text"]}')
            break
    detail = '两处信息' if len(samples) == 2 else '一个细节'
    return Exercise(target, f'从材料出一道同学能用{detail}回答的英文问题。然后给出答案和依据。',
                    samples, ['我的题目', '我的答案', '答案依据'],
                    f'问句清楚并能由材料作答；答案正确；依据覆盖题目要求的{detail}。',
                    '先挑一个在材料里确实有依据的信息。')


def audience_messages(target, context):
    if target['kind'] in SCHOOL_PLANNING:
        materials = ['原创通知\nFriday reading club: Sign up by Thursday. If it rains, meet in the library.', quoted(target)]
        groups = ['写给还没报名的同学', '写给已经报名、只想知道雨天去哪里的同学']
        answer = '第一条包含最迟周四报名，第二条包含下雨时去图书馆。分别检查是否符合各自需求。'
    else:
        materials = [quoted(target)]
        groups = ['告诉没读过课文的同学怎样理解这句话', '告诉老师你用哪处原文支持自己的理解']
        answer = '同伴收到易懂的概述，教师收到具体出处和用它支持结论的理由，两条都应保留原意。'
    return Exercise(target, '同一条材料写给两个读者，各写 1–2 句英文，再圈出为每位读者特意保留的信息。',
                    materials, groups, answer, '先想每位读者最想知道什么。')


def comic(target, context):
    return Exercise(target, '给三格原创场景卡写英文对白。每格一句，依次是提问、回答和确认。',
                    [quoted(target)],
                    ['① 同伴问', '② 我回答', '③ 同伴确认'],
                    '三处气泡各完成一个沟通目的。第二格准确使用原文信息，第三格保留前一句的意思。',
                    '第二格回答第一格真正问到的内容。', TEACHER_SCENE,
                    '可打印场景卡，也可由教师用获准分发的教材插画配这三格。',
                    panels=[
                        '同伴没读到课文里的一处关键信息。他转向你，提出一个问题。',
                        '你指向教材里能回答它的那一句，再用英语回答。',
                        '同伴复述刚听到的意思，向你确认。',
                    ])


def dictogloss(target, context):
    if target['kind'] in SCHOOL_PLANNING:
        script = ("Hi, this is a message about the photo club. Meet at five in the afternoon on Monday. "
                  "Sign up by Sunday. If the hall is closed, we'll meet in Room 8 instead.")
        answer = '识别摄影社团、周一下午五点、最迟周日报名，以及大厅关闭时到 8 号房间。接受同义复述。'
    else:
        script = f'Here is one point from our lesson. {target["evidence"]}'
        answer = f'抓住并重新传达这句话的主要信息；保留 {target["value"]} 所涉及的关键意思。接受同义复述。'
    return Exercise(target, '听老师提供的录音。第一遍听主旨，第二遍只记关键词，然后用 2–3 句英语把信息讲清楚。',
                    [], ['关键词', '我重建的英文通知或说明'],
                    answer, '用短词记下人物、动作和条件等主要信息。', f'{TEACHER_AUDIO}\n{script}',
                    '听后重建需要教师提供录音或朗读。')


def listening_numbers(target, context):
    if target['kind'] not in SCHOOL_PLANNING | {'number', 'comparison'}:
        return None
    return Exercise(target, '先听一条英文广播并填剩余名额。回放核对，再听下一条填写新名额。保留第一次填写的数字。',
                    [], ['第一遍的名额', '回放后的名额', '第二条放送的名额'],
                    '第一条为 13，第二条为 30。请分别核对第一次听辨和复听结果。',
                    '从整句判断它在讲名额，注意 -teen 和 -ty 的区别。',
                    f'{TEACHER_AUDIO}\n原创音频 A: There are thirteen places left.\n原创音频 B: There are thirty places left.',
                    '数字听辨需要教师提供两条音频或朗读。')


def predict_verify(target, context):
    if target['kind'] not in SCHOOL_PLANNING | {'direction', 'cause'}:
        return None
    return Exercise(target, '看下面的原创场景卡预测后续。听老师播放通知后，修订一句话并说出修订依据。',
                    ['替代画面：雨点落下来，原来在校门口等候的同学拿起工具往教学楼走。',
                     '教材中的相关表达\n' + quoted(target)],
                    ['我从场景猜到', '听完通知后的新安排', '我听到的证据'],
                    '先核对学生能否根据雨和同学移动来预测。实际通知要求两点照常开始，所有学生改去 4 号教室。合理的预测猜错仍计入第一项。',
                    '画面只能提示可能的变化。用听到的具体信息修订。',
                    f'{TEACHER_AUDIO}\n原创补充：The visit will still start at two, but all students must go to Room 4 instead.',
                    '预判活动附文字场景卡，开声核对需要教师提供录音或朗读。')


def voice_revision(target, context):
    return Exercise(target, '给没读过这段课文的同学说一条 20–30 秒的英语消息。用手机录一遍或请老师听，再回想漏掉的内容并重说。',
                    [quoted(target), '自查：核心事实说全了吗？说到条件、地点或时间时，听众能听清吗？'],
                    ['我的口头提纲', '第二遍改了什么'],
                    '用同一清单比较两次表达。按事实完整、信息顺序和可理解性核对，允许多种表达。',
                    '先组织信息再说，回听时只挑一处最值得改的地方。',
                    extra_note='语音留言可用手机本地录音或当面口述。')


METHODS = {
    'single_choice': single_choice,
    'short_fill': short_fill,
    'judgment_evidence': judgment_evidence,
    'short_response': short_response,
    'editing': editing,
    'sequencing': sequencing,
    'planning': planning,
    'branching': branching,
    'relationship_map': relationship_map,
    'route': route,
    'rule_discovery': rule_discovery,
    'rule_flip': rule_flip,
    'student_questions': student_questions,
    'audience_messages': audience_messages,
    'comic': comic,
    'dictogloss': dictogloss,
    'listening_numbers': listening_numbers,
    'predict_verify': predict_verify,
    'voice_revision': voice_revision,
}
TRADITIONAL = {'single_choice', 'short_fill', 'judgment_evidence', 'short_response'}
PREPARATION = {'dictogloss', 'listening_numbers', 'predict_verify'}
