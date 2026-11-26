"""Generate local classroom resources from verified PDF page anchors and original exercises."""
import argparse
import hashlib
import html
import json
import re
from pathlib import Path

import pymupdf
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt
from local_lesson import MaterialProblem, pdf_source, read_local, write_package


def lesson_html(spec, locator):
    esc = html.escape
    scenario = f'<p class="scenario">{esc(spec["scenario"])}</p>' if spec.get('scenario') else ''
    forms = []
    for number, question in enumerate(spec['questions'], 1):
        options = ''.join(f'<label><input type="radio" name="answer" value="{i}" required> {esc(text)}</label>'
                          for i, text in enumerate(question['options']))
        forms.append(f'''<form data-answer="{question['answer']}" data-feedback="{esc(question['feedback'], quote=True)}">
<fieldset><legend>{number}. {esc(question['prompt'])}</legend>{options}</fieldset>
<div class="actions"><button type="submit">检查答案</button><button type="reset">重做本题</button></div>
<output role="status"></output></form>''')
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>{esc(spec['name'])}</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f4f0e6;color:#172e28;font:18px/1.55 system-ui,sans-serif}}
main{{max-width:920px;padding:36px 20px;margin:auto}}h1{{font-size:clamp(27px,5vw,48px);line-height:1.15;margin:10px 0}}
.kicker{{color:#445950;font-weight:700}}.scenario{{border-left:4px solid #367664;padding:12px 18px;background:#e2ece3}}
form,section{{background:#fffcf4;border:1px solid #d8dace;border-radius:16px;padding:20px;margin:16px 0}}fieldset{{border:0;padding:0;margin:0}}
legend{{font-weight:750;margin-bottom:8px}}label{{display:block;padding:7px 0}}input{{accent-color:#205e4e}}
.actions{{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}}button{{padding:8px 14px;border:1px solid #205e4e;border-radius:8px;background:#205e4e;color:white;font:inherit;cursor:pointer}}button[type=reset]{{background:transparent;color:#205e4e}}
output:not(:empty){{display:block;margin-top:10px;font-weight:650}}footer{{font-size:14px;color:#455950}}
</style></head><body><main><header><div class="kicker">课堂练习 · 教师预览</div><h1>{esc(spec['name'])}</h1><p>{esc(spec['objective'])}</p></header>
{scenario}{''.join(forms)}<section><strong>课堂任务</strong><p>{esc(spec['transfer'])}</p></section>
<footer>教材定位：{esc(locator)}。练习为内部验证自编内容。</footer></main><script>
for (const form of document.querySelectorAll('form')) {{
  const output = form.querySelector('output');
  form.addEventListener('submit', event => {{
    event.preventDefault();
    const selected = new FormData(form).get('answer');
    output.textContent = selected === form.dataset.answer ? '答对了。' + form.dataset.feedback : '再试一次，或请同伴说说理由。';
  }});
  form.addEventListener('reset', () => {{ output.textContent = ''; }});
}}
</script></body></html>'''


PAPER = RGBColor.from_string('F4F0E6')
INK = RGBColor.from_string('172E28')
GREEN = RGBColor.from_string('205E4E')
WHITE = RGBColor.from_string('FFFFFF')


def box(slide, words, x, y, w, h, *, size=24, color=INK, bold=False, linked=None):
    if linked:
        shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = GREEN
        shape.line.fill.background()
        shape.click_action.target_slide = linked
    else:
        shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    text = shape.text_frame
    text.word_wrap = True
    text.margin_left = Inches(.16 if linked else 0)
    text.margin_right = Inches(.14 if linked else 0)
    text.margin_top = Inches(.11 if linked else 0)
    text.margin_bottom = 0
    run = text.paragraphs[0].add_run()
    run.text = words
    run.font.name = 'Microsoft YaHei'
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = WHITE if linked else color
    return shape


def make_deck(spec, locator, destination):
    deck = Presentation()
    deck.slide_width = Inches(13.333)
    deck.slide_height = Inches(7.5)
    deck.core_properties.title = spec['name']
    deck.core_properties.author = '英语教培工作台'
    slides = [deck.slides.add_slide(deck.slide_layouts[6]) for _ in range(6)]
    for index, slide in enumerate(slides, 1):
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = PAPER
        box(slide, f'英语教培工作台    /    教师预览    /    {index:02d}', .70, .44, 11.8, .32, size=13, color=GREEN, bold=True)
        box(slide, locator, .7, 7.07, 11.9, .25, size=10, color=GREEN)
    box(slides[0], spec['name'], .7, 1.3, 11.9, 1.35, size=44, bold=True)
    box(slides[0], spec['objective'], .7, 2.83, 11.9, .85, size=29)
    box(slides[0], '流程：理解目标 → 完成两道题 → 用自己的话迁移。', .7, 4.05, 11.9, 1.1, size=22)
    for i, question in enumerate(spec['questions']):
        slide, answer_slide = slides[1 + i * 2:3 + i * 2]
        box(slide, f'课堂投票  {i + 1}', .7, .94, 11.9, .51, size=29, bold=True)
        if spec.get('scenario'):
            box(slide, spec['scenario'], .7, 1.64, 11.9, 1.02, size=21)
        box(slide, question['prompt'], .7, 2.79, 11.9, .70, size=25, bold=True)
        for index, option in enumerate(question['options']):
            box(slide, f'{chr(65 + index)}.  {option}', .9, 3.7 + .57 * index, 11.6, .53, size=23)
        box(slide, '揭晓答案 →', .7, 5.85, 3.15, .65, size=20, linked=answer_slide)
        box(answer_slide, f'课堂投票  {i + 1}  ·  答案与理由', .7, 1.18, 11.9, .8, size=35, bold=True)
        box(answer_slide, f'{chr(65 + question["answer"])}.  {question["options"][question["answer"]]}', .7, 2.25, 11.9, .9, size=29, bold=True)
        box(answer_slide, question['feedback'], .7, 3.38, 11.9, 1.05, size=23)
        box(answer_slide, '继续 →', .7, 5.85, 3.15, .65, size=20, linked=slides[3 + i * 2])
    box(slides[-1], '课堂任务', .7, 1.3, 11.9, 1.05, size=42, bold=True)
    box(slides[-1], spec['transfer'], .7, 2.72, 11.9, 1.7, size=30)
    deck.save(destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('material', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('track', choices=['k12', 'toefl', 'ielts'])
    parser.add_argument('pages')
    parser.add_argument('--filename')
    parser.add_argument('--goal', default='')
    args = parser.parse_args()
    patterns = json.loads(Path(__file__).with_name('lessons.json').read_text(encoding='utf-8'))
    spec = patterns[args.track]
    material_name = args.filename or args.material.name
    known = rich_lesson = False
    generic = None
    if args.material.suffix.lower() == '.pdf':
        try:
            with pymupdf.open(args.material) as document:
                if not document.is_pdf or document.needs_pass or not len(document):
                    raise MaterialProblem('MATERIAL_INVALID')
                def matches(anchors_by_page):
                    for page, anchors in anchors_by_page.items():
                        if int(page) > len(document):
                            return False
                        content = re.sub(r'\s+', ' ', document[int(page) - 1].get_text()).lower()
                        if not all(anchor in content for anchor in anchors):
                            return False
                    return True

                base_anchors = spec['anchors']
                extra_anchors = spec.get('interactive_anchors', {})
                known = not args.goal and matches(base_anchors)
                rich_lesson = known and bool(extra_anchors) and matches(extra_anchors)
                if args.pages == 'auto':
                    selected = [int(page) for page in base_anchors | (extra_anchors if rich_lesson else {})] if known else [1, min(3, len(document))]
                    start, end = min(selected), max(selected)
                else:
                    try:
                        start, end = map(int, args.pages.split('-'))
                    except ValueError:
                        raise MaterialProblem('MATERIAL_RANGE') from None
                if not 1 <= start <= end <= len(document) or end - start >= 20:
                    raise MaterialProblem('MATERIAL_RANGE')
                known = known and all(start <= int(page) <= end for page in base_anchors)
                rich_lesson = known and rich_lesson and all(start <= int(page) <= end for page in extra_anchors)
                if known:
                    anchors_by_page = base_anchors | (extra_anchors if rich_lesson else {})
                    pages = ', '.join(sorted(anchors_by_page, key=int))
                    locator = f'{spec["source"]} · PDF {pages}'
                else:
                    generic = pdf_source(document, start, end)
        except MaterialProblem:
            raise
        except Exception:
            raise MaterialProblem('MATERIAL_INVALID') from None
    else:
        if args.pages != 'auto':
            raise MaterialProblem('MATERIAL_RANGE')
        generic = read_local(args.material)
    args.output.mkdir(parents=True, exist_ok=True)
    if generic:
        pages = generic.label
        locator = f'{material_name} · {pages}'
        title = f'{Path(material_name).stem[:56]} · 课堂活动'
        objective, slides = write_package(args.track, title, args.goal, locator, generic, args.output, box)
        activities = 3
    elif rich_lesson and args.track == 'k12':
        from k12 import render_html, render_pptx
        (args.output / 'lesson.html').write_text(render_html(locator), encoding='utf-8')
        render_pptx(locator, args.output / 'lesson.pptx')
        activities, slides = 3, 10
    elif rich_lesson:
        from exam_packages import render_html, render_pptx
        (args.output / 'lesson.html').write_text(render_html(args.track, locator), encoding='utf-8')
        activities, slides = 7, render_pptx(args.track, locator, args.output / 'lesson.pptx')
    else:
        (args.output / 'lesson.html').write_text(lesson_html(spec, locator), encoding='utf-8')
        make_deck(spec, locator, args.output / 'lesson.pptx')
        activities, slides = len(spec['questions']), 6
    if not generic:
        title = spec.get('interactive_name', spec['name']) if rich_lesson else spec['name']
        objective = spec.get('interactive_objective', spec['objective']) if rich_lesson else spec['objective']
    with args.material.open('rb') as file:
        source_hash = hashlib.file_digest(file, 'sha256').hexdigest()
    metadata = {'title': title, 'objective': objective, 'source': locator, 'pages': pages,
                'sha256': source_hash, 'activities': activities, 'slides': slides}
    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except MaterialProblem as error:
        raise SystemExit(str(error)) from None
