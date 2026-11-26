"""Identify locally grounded targets and export a teacher and student practice pack."""

import argparse
from html import escape
import json
from pathlib import Path
import sys
from zipfile import BadZipFile

from practice_activities import Exercise, METHODS, PREPARATION, TRADITIONAL, TIMING
from practice_material import PracticeProblem, analyze
from practice_visual import MAX_VISUAL_BYTES, RASTER_SOURCE, load_visual


CATALOG = Path(__file__).resolve().parent.parent / 'shared' / 'practice.json'
PUBLIC_TARGET_FIELDS = ('id', 'label', 'category', 'objective', 'evidence', 'locator')
DIFFICULTIES = {'guided', 'standard', 'challenge'}
MODES = {'mixed', 'traditional', 'activity'}
TRADITIONAL_ORDER = ('short_fill', 'judgment_evidence', 'short_response', 'single_choice')
ACTIVITY_ORDER = (
    'rule_flip', 'planning', 'sequencing', 'relationship_map', 'editing', 'rule_discovery',
    'student_questions', 'audience_messages', 'comic', 'route', 'voice_revision',
)
METHOD_MINUTES = {
    'single_choice': 1, 'short_fill': 1, 'judgment_evidence': 2, 'short_response': 3,
    'editing': 2, 'sequencing': 3, 'planning': 4, 'branching': 4, 'relationship_map': 3, 'route': 3,
    'rule_discovery': 3, 'rule_flip': 3, 'student_questions': 3, 'audience_messages': 3, 'comic': 4,
    'dictogloss': 4, 'listening_numbers': 3, 'predict_verify': 4, 'voice_revision': 4,
}
SEQUENCE_MINUTES = {'standard': 0, 'scaffold': 2, 'revise': 2, 'spaced': 0}
STYLE = """
*{box-sizing:border-box}
body{margin:0;color:#211d2b;background:#f4f1f8;font:16px/1.6 system-ui,'Microsoft YaHei',sans-serif}
main{max-width:780px;margin:0 auto;padding:28px 20px 52px}
header{padding-bottom:12px;border-bottom:1px solid #d9d2e3;margin-bottom:18px}
h1{line-height:1.2;font-size:clamp(24px,5vw,36px);margin:8px 0}
h2{font-size:20px;line-height:1.4;margin:0 0 8px}
h3{font-size:16px;margin:14px 0 3px}
p{margin:6px 0 12px}
.meta,.location{color:#524a60}
section{break-inside:avoid;margin:14px 0;padding:18px;border:1px solid #d9d2e3;background:white;border-radius:8px}
.material{display:block;padding:8px 10px;margin:8px 0;background:#f4f1f8;border-left:2px solid #9b88bc;white-space:pre-wrap;overflow-wrap:anywhere}
.exercise-visual{margin:12px 0;break-inside:avoid}
.exercise-visual img{display:block;max-width:100%;height:auto;margin:0 auto}
.exercise-visual figcaption{margin-top:5px;color:#524a60;font-size:.9em;text-align:center}
.choice{display:block;padding:4px 0}
.choice input{margin-inline-end:8px}
input,textarea{font:inherit;color:inherit}
.response{display:block;margin:10px 0 14px}
.response textarea{display:block;width:100%;min-height:36px;border:0;border-bottom:1px solid #7b7189;padding:4px 0;resize:vertical}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,155px),1fr));gap:10px;margin-top:12px}
.panel{border:1px solid #d9d2e3;border-radius:8px;padding:12px}
.panel .response{margin:6px 0 0;font-weight:650}
.panel textarea{min-height:52px;border:1px solid #7b7189;border-radius:12px 12px 12px 3px;margin-top:6px;padding:6px;background:#fff}
:focus-visible{outline:2px solid #62419b;outline-offset:2px}
.later{margin-top:24px;border-top:2px solid #9b88bc}
.audio-first-end{border-bottom:1px dashed #9b88bc;padding:0 0 10px}
@media print{
  body{background:white;color:black;font-size:11pt}
  main{padding:0;max-width:none}
  section{border:1px solid #aaa;box-shadow:none}
  .material{background:white;border-color:#aaa}
  .exercise-visual img{max-height:82mm;width:auto;object-fit:contain}
  .later,.audio-first-end{break-after:page}
  .later{break-before:page;break-after:auto}
  .response textarea{min-height:26px;resize:none}
}
"""


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


def normal_label(method, catalog):
    return catalog[method]['label']


def exercise_for(method, targets, analysis, options, covered):
    for target in sorted(targets, key=lambda item: item['id'] in covered):
        index = target['block']
        near = analysis['blocks'][max(0, index - 4):index + 5]
        exercise = METHODS[method](target, {'nearby': near, 'difficulty': options['difficulty'], 'sequence': options['sequence']})
        if exercise:
            return exercise
    return None


def choices_for(analysis, options, catalog):
    target_by_id = {target['id']: target for target in analysis['targets']}
    selection = options['target_ids']
    methods = options['methods']
    mode = options.get('mode', 'mixed')
    if (not 1 <= len(selection) <= 3 or len(selection) != len(set(selection)) or len(methods) > 4
            or len(methods) != len(set(methods)) or mode not in MODES):
        raise PracticeProblem('PRACTICE_INVALID')
    targets = [target_by_id[key] for key in selection]
    notes = []
    chosen = []
    covered = set()

    def consider(method, explicit=False):
        exercise = exercise_for(method, targets, analysis, options, covered)
        if not exercise:
            if explicit:
                notes.append(f'{normal_label(method, catalog)}需要与题型匹配的材料证据，当前目标暂未生成此题。')
            return False
        chosen.append((method, exercise))
        covered.add(exercise.target['id'])
        if exercise.extra_note and exercise.extra_note not in notes:
            notes.append(exercise.extra_note)
        return True

    if methods:
        for method in methods:
            consider(method, explicit=True)
    else:
        if mode != 'activity':
            for method in TRADITIONAL_ORDER[:3]:
                consider(method)
        if mode != 'traditional':
            count = 0
            for method in ACTIVITY_ORDER:
                count += consider(method)
                if count == (2 if mode == 'activity' else 1):
                    break
        if mode == 'mixed' and not any(method not in TRADITIONAL for method, _ in chosen):
            notes.append('当前材料未生成特色活动，本次组合只含传统练习。')

    if not chosen:
        raise PracticeProblem('PRACTICE_NO_METHOD')

    used_methods = [method for method, _ in chosen]
    for target in targets:
        if target['id'] in covered:
            continue
        if methods:
            notes.append(f'「{target["label"]}」尚未被所选练法覆盖，可调整选择后再生成。')
            continue
        filler = 'editing' if mode == 'activity' else 'short_response'
        exercise = exercise_for(filler, [target], analysis, options, covered)
        if exercise:
            chosen.append((filler, exercise))
            covered.add(target['id'])
            if filler not in used_methods:
                used_methods.append(filler)
    # The student worksheet places a listening round before any other reading that
    # could otherwise disclose information from the material being heard.
    chosen.sort(key=lambda entry: entry[0] not in PREPARATION)
    return chosen, list(dict.fromkeys(method for method, _ in chosen)), notes


def text(value):
    return escape(str(value), quote=True)


def materials_view(materials):
    return ''.join(f'<div class="material">{text(material)}</div>' for material in materials)


def visuals_view(visuals):
    figures = []
    for visual in visuals:
        if not RASTER_SOURCE.fullmatch(visual.data_url):
            raise PracticeProblem('PRACTICE_IMAGE')
        caption = f'<figcaption>{text(visual.caption)}</figcaption>' if visual.caption else ''
        figures.append(
            f'<figure class="exercise-visual"><img src="{text(visual.data_url)}" alt="{text(visual.alt)}" '
            f'width="{int(visual.width)}" height="{int(visual.height)}">{caption}</figure>'
        )
    return ''.join(figures)


def fields_view(fields):
    return ''.join(f'<label class="response">{text(label)}<textarea rows="1"></textarea></label>' for label in fields)


def panels_view(item, teacher):
    panels = []
    for scene, speaker in zip(item.panels, item.fields, strict=True):
        action = f'<strong>{text(speaker)}</strong>' if teacher else fields_view([speaker])
        panels.append(f'<div class="panel"><p>{text(scene)}</p>{action}</div>')
    return f'<div class="panels">{"".join(panels)}</div>'


def item_view(method, item, number, catalog, teacher=False, give_hint=False):
    heading = item.heading or normal_label(method, catalog)
    parts = [
        f'<section><h2>{number}. {text(heading)}</h2>',
        f'<p>{text(item.prompt)}</p>{materials_view(item.materials)}{visuals_view(item.visuals)}',
    ]
    if item.choices:
        choices = ''.join(
            f'<label class="choice"><input type="radio" name="item-{number}">{chr(65 + i)}. {text(option)}</label>'
            for i, option in enumerate(item.choices)
        )
        parts.append(f'<div role="group" aria-label="第 {number} 题选项">{choices}</div>')
    if item.panels:
        parts.append(panels_view(item, teacher))

    if teacher:
        parts.append(f'<p class="location">核对目标 · {text(item.target["label"])} · {text(item.target["locator"])}</p>')
        parts.append(f'<h3>教材证据</h3>{materials_view([item.target["evidence"]])}')
        if item.teacher_preparation:
            parts.append(f'<h3>教师准备</h3>{materials_view([item.teacher_preparation])}')
        parts.append(f'<h3>答案或评分点</h3><p>{text(item.answer)}</p><h3>订正提示</h3><p>{text(item.hint)}</p>')
    else:
        if not item.panels:
            parts.append(fields_view(item.fields))
        if give_hint:
            parts.append(f'<p class="meta">提示 · {text(item.hint)}</p>')

    parts.append('</section>')
    return ''.join(parts)


def scaffold_view(target, teacher, audio_only=False):
    if audio_only:
        demo = '范例听后记 “art club / Tuesday / 3 p.m.”，转述为 “The art club meets at 3 p.m. on Tuesday.”'
        partial = '再从 “The chess club meets at 4 p.m. on Monday.” 选三个词做笔记。'
        key = '示例笔记 chess club / Monday / 4 p.m. 播放主练习时先听再记。'
    elif target['kind'] in TIMING:
        demo = 'The art class is on Monday. “On Monday”告诉读者活动在哪天。'
        partial = 'The drawing club meets ___ Tuesday. 写出空格，并判断它表达活动日还是截止日。'
        key = '半成品参考答案 on，说明活动日。随后独立完成主任务。'
    elif target['kind'] == 'direction':
        demo = 'Turn right at the gate. “Right”表方向，“at the gate”指的是转弯地标。'
        partial = '补全指路话语 “Turn ___ at the library.” 你在图书馆向左转。'
        key = '半成品参考答案 left，再独立完成主任务。'
    elif target['kind'] == 'conditional':
        demo = "If it is windy, we'll close the door. “If it is windy”是条件。"
        partial = '请给 “If the bus is late, ___.” 补一个合理的行动。'
        key = '半成品接受与迟到有关且可执行的行动，如 we will call the teacher。'
    else:
        demo = 'The school lends raincoats on wet days. 可以根据 “on wet days” 判断借雨衣的条件。'
        partial = '根据 “Musicians can practise in Room 3 after class.” 补一句给同学的消息，先写自己能确定的事实。'
        key = '参考信息为音乐练习可以在 3 号教室进行，时间是课后。接着独立找主任务里要求的信息。'
    answer = f'<p>{text(key)}</p>' if teacher else fields_view(['我补全的内容'])
    return f'<section><h2>先看一个范例</h2>{materials_view([demo, partial])}{answer}</section>'


def delayed_question(target):
    if target['kind'] == 'deadline':
        return '摄影活动最迟周二报名。独立写一句英语通知。', 'Sign up by Tuesday. 核对 by 是否准确表达最迟日期。'
    if target['kind'] == 'date':
        return '篮球练习在周二举行。独立写一句英语通知。', 'Basketball practice is on Tuesday. 核对 on 加星期。'
    if target['kind'] == 'clock':
        return '摄影社团下午六点在体育馆集合。独立写一句英语通知。', 'Meet in the gym at 6 p.m. 核对 at 加钟点。'
    if target['kind'] == 'conditional':
        return '如果礼堂锁了，就去 7 号教室。独立用英语给同伴留言。', "If the hall is locked, we'll go to Room 7. 核对条件和行动的对应。"
    if target['kind'] == 'direction':
        return '你面向北，在教学楼前转向东。写一句英语指路。', 'Turn right at the classroom building. 核对方向变化和地标。'
    if target['kind'] == 'order':
        return '先看展板，接着采访一名同学，最后写下发现。用英语给新生写三个有顺序的步骤。', '至少使用两种恰当顺序线索，把三个活动排在正确位置。'
    if target['kind'] == 'cause':
        return '雨弄湿了球场，社团移到了室内。用一句话向同学说明原因和结果。', '参考 The club moved inside because the court was wet. 原因与结果对应即可。'
    if target['kind'] in {'comparison', 'number'}:
        return '读 “The chess club has 18 members; the reading club has 21.” 说出哪个社团人数多，并给出差值。', '读书会人更多，多 3 人。核对两个数字、方向和比较结果。'
    if target['kind'] == 'vocabulary':
        return f'在一个新的场景里用 {target["value"]} 写一句英文，补充一句使词义更清楚。', '核对目标词的含义、搭配和新语境是否一致。'
    return (
        '阅读 “The woodwork club has moved to Room 9. Use the east door if the main entrance is closed.” '
        '用英文向缺席的同学说明活动的新地点和备用入口。',
        'Room 9 是新地点。主入口关闭时走东门；核对概述没有漏掉条件。',
    )


def followup_view(sequence, target, teacher):
    if sequence == 'revise':
        prompt = '保留主任务首答。拿到老师给的针对性提示后，选一处修改，并写下理由。'
        work = '<p>教师可发对应题目的订正提示，保留首答和订正两份记录。</p>' if teacher else fields_view(['我修订的地方', '我为什么这么改'])
        return f'<section class="later"><h2>订正</h2><p>{text(prompt)}</p>{work}</section>'
    if sequence == 'spaced':
        prompt, answer = delayed_question(target)
        work = f'<p>{text(answer)}</p>' if teacher else fields_view(['下次作答'])
        return (f'<section class="later"><h2>复练卡</h2><p class="meta">教师可另页打印，下次课或下一份练习独立完成。</p>'
                f'<p>{text(prompt)}</p>{work}</section>')
    return ''


def render(analysis, items, options, catalog, sequences, duration, teacher=False):
    if sum(len(visual.data_url) for _, item in items for visual in item.visuals) > MAX_VISUAL_BYTES:
        raise PracticeProblem('PRACTICE_IMAGE')
    sequence = options['sequence']
    title = f'{analysis["material"]} · {"教师参考" if teacher else "学生练习"}'
    source = text(analysis['source'])
    sequence_label = text(sequences[sequence]['label'])
    intro = ('教材来源、参考答案和评分点供发放前核对。' if teacher
             else '写在每题的作答区，也可以打印后手写。')
    parts = [
        f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
        f'<title>{text(title)}</title><style>{STYLE}</style></head><body><main><header>',
        f'<h1>{text(title)}</h1><p class="meta">{source} · 约 {duration} 分钟 · {sequence_label}</p><p>{intro}</p></header>',
    ]
    hearing = [(i, method, item) for i, (method, item) in enumerate(items, 1) if method in PREPARATION]
    main = [(i, method, item) for i, (method, item) in enumerate(items, 1) if method not in PREPARATION]
    if sequence == 'scaffold' and hearing and not main:
        parts.append(scaffold_view(hearing[0][2].target, teacher, audio_only=True))
    if hearing and not teacher:
        parts.append('<p>先做听力部分，再阅读后面的练习。</p>')
    for i, method, item in hearing:
        parts.append(item_view(method, item, i, catalog, teacher))
    if hearing and main:
        parts.append('<p class="audio-first-end">听力部分结束</p>')
    if sequence == 'scaffold' and main:
        parts.append(scaffold_view(main[0][2].target, teacher))
    for i, method, item in main:
        parts.append(item_view(method, item, i, catalog, teacher, give_hint=options['difficulty'] == 'guided' and sequence == 'standard'))
    parts.append(followup_view(sequence, items[0][1].target, teacher))
    parts.append('</main></body></html>')
    return ''.join(parts)


def picture_exercise(target, image_path, options):
    alt = options.get('image_alt') or ''
    prompt = (options.get('image_prompt') or '').strip()
    return Exercise(
        target=target,
        prompt=prompt or 'Look at the picture. Pick one detail and describe it in 1–2 English sentences.',
        materials=[],
        fields=['图中线索与我的回答'],
        answer='评分参考。图中线索真实且具体 1 分，回答符合题干 1 分，英语表达清楚并体现本题练习目标 1 分。',
        hint='先找出能直接从图中看到的一处线索，再用目标表达把它说清楚。',
        teacher_preparation='配图为本项目教师添加。发放前核对题干能凭图作答，并按图中实际线索接受合理表达。',
        visuals=[load_visual(image_path, alt)],
        heading='看图表达',
    )


def generate(analysis, output, options, image_path=None):
    catalog = load_json(CATALOG)
    methods = {method['id']: method for method in catalog['methods']}
    sequences = {sequence['id']: sequence for sequence in catalog['sequences']}
    sequence = options['sequence']
    if sequence not in sequences or options['difficulty'] not in DIFFICULTIES:
        raise PracticeProblem('PRACTICE_INVALID')
    items, used_methods, notes = choices_for(analysis, options, methods)
    if image_path is not None:
        target = next(target for target in analysis['targets'] if target['id'] == options['target_ids'][0])
        items.append(('short_response', picture_exercise(target, image_path, options)))
        if 'short_response' not in used_methods:
            used_methods.append('short_response')
        notes.append('已添加教师配图的看图表达题。')
    if sequence == 'spaced':
        notes.append('复练卡可另页打印，留到下一次课程独立完成。')
    duration = sum(METHOD_MINUTES[method] for method, _ in items) + SEQUENCE_MINUTES[sequence]
    output.mkdir(parents=True, exist_ok=True)
    for teacher, name in ((False, 'student.html'), (True, 'teacher.html')):
        (output / name).write_text(render(analysis, items, options, methods, sequences, duration, teacher=teacher), encoding='utf-8')
    labels = list(dict.fromkeys(item.target['label'] for _, item in items))
    return {
        'title': f'{analysis["material"]} · 课后练习',
        'source': analysis['source'],
        'objective': '；'.join(labels),
        'item_count': len(items),
        'methods': used_methods,
        'sequence': sequence,
        'duration_min': duration,
        'notes': notes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='action', required=True)
    identify = subparsers.add_parser('identify')
    identify.add_argument('material', type=Path)
    identify.add_argument('output', type=Path)
    identify.add_argument('filename')
    identify.add_argument('pages')
    identify.add_argument('focus')
    generate_parser = subparsers.add_parser('generate')
    generate_parser.add_argument('analysis', type=Path)
    generate_parser.add_argument('output', type=Path)
    generate_parser.add_argument('options', type=Path)
    generate_parser.add_argument('--image', type=Path)
    args = parser.parse_args()

    try:
        if args.action == 'identify':
            result = analyze(args.material, args.filename, args.pages, args.focus)
            args.output.mkdir(parents=True, exist_ok=True)
            write_json(args.output / 'analysis.json', result)
            result = {
                'title': result['title'], 'source': result['source'],
                'targets': [{key: target[key] for key in PUBLIC_TARGET_FIELDS} for target in result['targets']],
            }
        else:
            result = generate(load_json(args.analysis), args.output, load_json(args.options), args.image)
    except PracticeProblem as error:
        print(error, file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, BadZipFile):
        print('PRACTICE_INVALID', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
