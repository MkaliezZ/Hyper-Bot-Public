"""Build the Unit 1 interaction for the browser and local slide shows."""
from base64 import b64encode
from html import escape
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from slide_effects import fade_on_click, transition


ASSETS = Path(__file__).parent
HERO = ASSETS / 'meet-at-school.jpg'
PAPER = 'F6F1E5'
INK = '172E2A'
GREEN = '184E43'
MINT = 'D7E9DC'
GOLD = 'F4CA73'
CORAL = 'A34734'
WHITE = 'FFFDF8'


def render_html(locator):
    picture = 'data:image/jpeg;base64,' + b64encode(HERO.read_bytes()).decode('ascii')
    template = (ASSETS / 'k12-lesson.html').read_text(encoding='utf-8')
    return template.replace('__SOURCE__', escape(locator)).replace('__HERO_SRC__', picture)


def label(slide, text, x, y, width, height, *, size=19, ink=INK, fill=None, bold=False, target=None):
    coords = [Inches(n) for n in (x, y, width, height)]
    if fill:
        shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, *coords)
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string(fill)
        shape.line.fill.background()
    else:
        shape = slide.shapes.add_textbox(*coords)
    if target is not None:
        shape.click_action.target_slide = target
    frame = shape.text_frame
    frame.word_wrap = True
    frame.margin_left = Inches(.18 if fill else 0)
    frame.margin_right = Inches(.13 if fill else 0)
    frame.margin_top = Inches(.10 if fill else 0)
    frame.margin_bottom = 0
    for index, line in enumerate(text.splitlines()):
        paragraph = frame.add_paragraph() if index else frame.paragraphs[0]
        run = paragraph.add_run()
        run.text = line
        run.font.name = 'Microsoft YaHei'
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = RGBColor.from_string(ink)
    return shape


def action(slide, text, x, y, width, target, *, fill=GREEN, ink=WHITE):
    return label(slide, text, x, y, width, .57, size=17, fill=fill, ink=ink, bold=True, target=target)


def picture(slide, x, y, width, target=None):
    shape = slide.shapes.add_picture(str(HERO), Inches(x), Inches(y), width=Inches(width))
    if target is not None:
        shape.click_action.target_slide = target
    return shape


def render_pptx(locator, destination):
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    deck.core_properties.title = 'You and Me · 新朋友任务'
    deck.core_properties.author = '英语教培工作台'
    slides = [deck.slides.add_slide(deck.slide_layouts[6]) for _ in range(10)]
    titles = [
        ('You and Me', '找一句合适的话，认识一位新朋友。'),
        ('走廊相遇', '点图上的人物，打开他们的第一句问候。'),
        ('Mia 挥手', '想认识别人，可以先打招呼，再礼貌问姓名。'),
        ('Leo 也挥手', '先回应问候，也可以介绍自己的名字。'),
        ('接住对方的话', 'Mia: May I have your name?'),
        ('接住了！', '对方问姓名，所以可以说 I’m + 名字。'),
        ('再试一句', 'Class 7 说明班级。对方现在想知道姓名。'),
        ('图板侦探', '为两位人物各找一条图文线索，再点开人物证据。'),
        ('图板揭晓', '用自我介绍里的一个短语支持你的选择。'),
        ('搭档名片', '用虚构名字练习，和同伴互换角色。'),
    ]
    effects = [('fade', None), ('push', 'l'), ('fade', None), ('fade', None), ('wipe', 'r'),
               ('fade', None), ('wipe', 'l'), ('push', 'l'), ('wipe', 'r'), ('push', 'l')]
    for num, slide in enumerate(slides):
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = RGBColor.from_string(PAPER)
        title, sub = titles[num]
        label(slide, 'UNIT 1    /    教师预览', .62, .43, 8, .28, size=13, ink=GREEN, bold=True)
        label(slide, f'{num + 1:02d} / {len(slides)}', 11.47, .43, 1.25, .28, size=13, ink=GREEN)
        label(slide, title, .62, .92, 11.95, .7, size=40, bold=True)
        label(slide, sub, .62, 1.76, 11.95, .48, size=21)
        label(slide, locator, .62, 7.06, 12, .28, size=10, ink=GREEN)
        transition(slide, *effects[num])

    cover, scene, mia, leo, dialog, correct, retry, clues, reveal, partners = slides
    picture(cover, 6.40, 2.24, 6.24, scene)
    action(cover, '走廊相遇 →', .62, 2.65, 4.5, scene)
    action(cover, '图板侦探 →', .62, 3.45, 4.5, clues, fill=MINT, ink=GREEN)
    action(cover, '搭档名片 →', .62, 4.25, 4.5, partners, fill=MINT, ink=GREEN)

    picture(scene, .62, 2.31, 6.52, mia)
    action(scene, 'Mia', 1.22, 4.75, 1.38, mia, fill=GOLD, ink=INK)
    action(scene, 'Leo', 5.38, 4.75, 1.36, leo, fill=GOLD, ink=INK)
    label(scene, 'What can you say first?', 7.61, 2.78, 4.87, .78, size=28, bold=True)
    label(scene, '看图后，请两位同学演出第一句。', 7.61, 3.88, 4.82, .58, size=19)
    action(scene, '进入对话挑战 →', 7.61, 4.65, 4.22, dialog)
    action(scene, '课程首页', 7.61, 5.42, 4.22, cover, fill=MINT, ink=GREEN)

    for slide, phrase, accent in [(mia, 'Hi! I’m Mia.\nMay I have your name?', GOLD), (leo, 'Nice to meet you, Mia!\nI’m Leo.', MINT)]:
        picture(slide, 6.52, 2.28, 6.11, scene)
        bubble = label(slide, phrase, .62, 2.81, 5.45, 1.63, size=25, fill=accent, bold=True)
        fade_on_click(slide, bubble)
        label(slide, '放映时单击空白处，显示人物台词。', .65, 4.50, 5.72, .35, size=14, ink=GREEN)
        action(slide, '返回图片', .62, 5.04, 2.52, scene, fill=MINT, ink=GREEN)
        action(slide, '接对话 →', 3.38, 5.04, 2.52, dialog)

    action(dialog, 'A    I’m Leo.', .62, 2.94, 8.5, correct)
    action(dialog, 'B    I’m from Class 7.', .62, 3.77, 8.5, retry, fill=MINT, ink=GREEN)
    action(dialog, '返回走廊', .62, 5.13, 3.41, scene, fill=WHITE, ink=GREEN)
    label(correct, 'I’m Leo.', .62, 2.80, 8.53, 1.19, size=37, fill=MINT, bold=True)
    action(correct, '去找图文线索 →', .62, 4.52, 4.01, clues)
    action(correct, '再演一次', 4.89, 4.52, 3.15, dialog, fill=WHITE, ink=GREEN)
    label(retry, '班级信息可以留到下一轮。', .62, 2.80, 8.53, 1.0, size=28, fill=GOLD, bold=True)
    action(retry, '返回对话，重新选择 →', .62, 4.35, 4.65, dialog)

    label(clues, 'Pauline Lee\nMy favourite sport is tennis.', .62, 2.67, 5.78, 1.46, size=23, fill=GOLD, bold=True, target=reveal)
    label(clues, 'Peter Brown\nI like music, and I play the guitar.', 6.65, 2.67, 6.0, 1.46, size=23, fill=MINT, bold=True, target=reveal)
    label(clues, '候选线索：网球、吉他、鹦鹉', .62, 4.43, 11.6, .53, size=21)
    action(clues, '揭晓配对 →', .62, 5.25, 4.13, reveal)
    label(reveal, 'Pauline  →  tennis\nShe is the tennis player.', .62, 2.68, 5.77, 1.50, size=25, fill=GOLD, bold=True)
    peter_card = label(reveal, 'Peter  →  guitar\nHe plays the guitar.', 6.65, 2.68, 6.0, 1.50, size=25, fill=MINT, bold=True)
    fade_on_click(reveal, peter_card)
    label(reveal, '放映时单击空白处，再揭晓 Peter 的线索。', .65, 4.36, 11.8, .38, size=15, ink=GREEN)
    action(reveal, '回到线索', .62, 5.04, 3.5, clues, fill=WHITE, ink=GREEN)
    action(reveal, '做搭档名片 →', 4.45, 5.04, 3.9, partners)
    label(partners, 'A   介绍自己\nHi! I am ___. I like ___.', .62, 2.67, 5.77, 1.67, size=25, fill=MINT, bold=True)
    label(partners, 'B   介绍同伴\nThis is my friend ___.', 6.65, 2.67, 6.0, 1.67, size=25, fill=GOLD, bold=True)
    action(partners, '返回课程首页', .62, 5.12, 4, cover)
    deck.save(destination)
