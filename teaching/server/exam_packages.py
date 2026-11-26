"""Author two source-specific examination lessons for offline HTML and PPTX."""
import json
from html import escape
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from slide_effects import fade_on_click, transition


TEMPLATES = Path(__file__).with_name('exam')
TRAVEL_DATA = [
    {'key': 'walking', 'label': '步行', 'en': 'Walking', 'values': [13, 6]},
    {'key': 'car', 'label': '汽车', 'en': 'Car', 'values': [4, 11]},
    {'key': 'bus', 'label': '公交', 'en': 'Bus', 'values': [7, 5]},
    {'key': 'cycling', 'label': '骑行', 'en': 'Cycling', 'values': [6, 2]},
    {'key': 'combined', 'label': '步行加公交', 'en': 'Walk + bus', 'values': [6, 3]},
]


def render_html(track, locator):
    document = (TEMPLATES / f'{track}.html').read_text(encoding='utf-8')
    return (document.replace('__STYLE__', (TEMPLATES / 'base.css').read_text(encoding='utf-8'))
            .replace('__COMMON__', (TEMPLATES / 'base.js').read_text(encoding='utf-8'))
            .replace('__SOURCE__', escape(locator))
            .replace('__TRAVEL_DATA__', json.dumps(TRAVEL_DATA, ensure_ascii=False)))


class Deck:
    def __init__(self, track, name, locator, headlines):
        self.deck = Presentation()
        self.deck.slide_width, self.deck.slide_height = Inches(13.333), Inches(7.5)
        self.deck.core_properties.title = name
        self.deck.core_properties.author = '英语教培工作台'
        self.paper, self.ink, self.accent, self.soft, self.mark = (
            ('EBF3F1', '112B36', '075B62', 'D9EDED', 'F0C569') if track == 'TOEFL'
            else ('F3EEF8', '2A2040', '563F81', 'EAE1F5', 'EEC99A')
        )
        self.slides = []
        for number, (title, note) in enumerate(headlines, 1):
            slide = self.deck.slides.add_slide(self.deck.slide_layouts[6])
            self.slides.append(slide)
            slide.background.fill.solid()
            slide.background.fill.fore_color.rgb = RGBColor.from_string(self.paper)
            self.text(slide, track, .64, .33, 4.4, .34, size=13, bold=True, ink=self.accent)
            self.text(slide, f'{number:02} / {len(headlines)}', 11.45, .33, 1.35, .34, size=13, ink=self.accent)
            self.text(slide, title, .64, .82, 12.02, .79, size=39, bold=True)
            self.text(slide, note, .64, 1.69, 12.02, .50, size=19)
            self.text(slide, locator, .64, 7.10, 12, .22, size=9, ink=self.accent)
            if number % 3 == 2:
                transition(slide, 'push', 'l')
            elif number % 3 == 0:
                transition(slide, 'wipe', 'r')
            else:
                transition(slide, 'fade')

    def text(self, slide, copy, x, y, width, height, *, size=23, bold=False, fill=None, ink=None, target=None):
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
        frame.margin_left = Inches(.20 if fill else 0)
        frame.margin_right = Inches(.16 if fill else 0)
        frame.margin_top = Inches(.12 if fill else 0)
        frame.margin_bottom = 0
        for index, paragraph_text in enumerate(copy.splitlines()):
            p = frame.add_paragraph() if index else frame.paragraphs[0]
            p.space_after = Pt(4 if fill else 2)
            run = p.add_run()
            run.text = paragraph_text
            run.font.name = 'Microsoft YaHei'
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.color.rgb = RGBColor.from_string(ink or self.ink)
        return shape

    def button(self, slide, copy, x, y, width, target, *, quiet=False):
        return self.text(slide, copy, x, y, width, .59, size=17, bold=True,
                         ink=self.accent if quiet else 'FFFFFF', fill=self.soft if quiet else self.accent, target=target)

    def pair(self, slide, left_text, right_text, *, y=2.55, size=23, height=2.25):
        left = self.text(slide, left_text, .64, y, 5.88, height, size=size, fill=self.soft)
        right = self.text(slide, right_text, 6.78, y, 5.88, height, size=size, fill=self.mark)
        return left, right

    def reveal(self, slide, shape):
        fade_on_click(slide, shape)
        self.text(slide, '放映时单击空白处揭晓。', .68, 5.70, 11.5, .37, size=15, ink=self.accent)

    def finish(self, destination):
        self.deck.save(destination)
        return len(self.slides)


def toefl_deck(locator, destination):
    d = Deck('TOEFL', '读懂通知与邮件', locator, [
        ('读懂通知与邮件', '先读谁、为何，再找更新、条件和证据。'),
        ('通知是谁写给谁？', '用 20 秒扫读。两个日期里，哪个是这则通知的重点？'),
        ('选一张有效日历', '点一张日期卡，验证它还是有效安排。'),
        ('找到新安排', '用文本中的 will now take place 支持选择。'),
        ('旧日期干扰', 'originally scheduled 表明这是先前的时间。'),
        ('点选有效证据', '问题问 When。选能直接支持“现在什么时候开会”的片段。'),
        ('预订邮件的四个区域', '任选一格，说说你会如何将它转述给客户。'),
        ('取消条款推演', '客户已付订金，在活动前 10 天取消，会发生什么？'),
        ('核对 10 天与 14 天', '对照真实数字和 at least 的边界。'),
        ('推荐与承诺的区别', '读服务段。外部推荐和自有服务有什么区别？'),
        ('两张通知互相冲突', '新通知只改地点。找出最新地点和仍有效的截止时间。'),
        ('迁移揭晓', '用一句口头提醒同时带出地点和截止时间。'),
        ('三行出口卡', '选任一份文本，写完交给同伴核对证据。'),
    ])
    home, notice, calendar, yes, old, proof, email, cancel, result, terms, transfer, model, final = d.slides
    d.button(home, '改期通知 →', .64, 2.75, 4.08, notice)
    d.button(home, '预订邮件 →', .64, 3.55, 4.08, email)
    d.button(home, '两份文档的迁移 →', .64, 4.35, 4.08, transfer)
    d.text(home, 'Purpose\nWhat changed?\nWhat should the reader do?\nWhich line proves it?', 5.4, 2.49, 6.95, 3.15, size=29, fill=d.soft, bold=True)

    d.text(notice, 'STAFF MEETING UPDATE\nThe staff meeting originally scheduled for Wednesday, August 10 at 2:00 p.m. has been rescheduled. It will now take place on Friday, August 12 at 3:00 p.m. in the main conference room.', .64, 2.52, 11.9, 2.49, size=25, fill=d.soft)
    d.button(notice, '打开两张日历 →', .64, 5.33, 4.2, calendar)
    left, right = d.pair(calendar, 'WEDNESDAY\n10 AUG\n2:00 PM', 'FRIDAY\n12 AUG\n3:00 PM', size=32, height=2.47)
    left.click_action.target_slide = old
    right.click_action.target_slide = yes
    d.button(calendar, '重读通知', .64, 5.46, 4.08, notice, quiet=True)
    reveal = d.text(yes, 'Friday · 12 August · 3:00 p.m.\nMain conference room', .64, 2.63, 11.35, 1.72, size=30, fill=d.soft, bold=True)
    d.reveal(yes, reveal)
    d.button(yes, '找证据 →', .64, 4.80, 3.6, proof)
    d.text(old, 'Wednesday at 2:00 p.m. was the original plan.\nLook for the phrase that gives the current plan.', .64, 2.63, 11.35, 1.65, size=27, fill=d.mark)
    d.button(old, '返回，重新点日历 →', .64, 4.55, 4.95, calendar)
    d.button(proof, 'A  originally scheduled for Wednesday', .64, 2.63, 10.3, old, quiet=True)
    d.button(proof, 'B  will now take place on Friday at 3:00 p.m.', .64, 3.42, 10.3, yes)
    d.text(proof, '地点也重要，但它回答 Where。', .64, 4.39, 11.3, .52, size=21)
    d.button(proof, '进入预订邮件 →', .64, 5.34, 4.6, email)

    targets = [('附件 · 菜单', terms), ('服务 · 摄影推荐', terms), ('订金 · 30%', cancel), ('取消 · 14 天', cancel)]
    for i, (label, target) in enumerate(targets):
        d.button(email, label, .64 + (i % 2) * 6.12, 2.69 + (i // 2) * .96, 5.68, target, quiet=i < 2)
    d.text(email, '阅读训练：先扫段落功能，再找具体条件。', .64, 4.89, 11.3, .52, size=22)
    d.button(email, '两张通知挑战', .64, 5.62, 4.6, transfer, quiet=True)
    d.button(cancel, 'A  保留订金', .64, 2.66, 9.25, terms, quiet=True)
    d.button(cancel, 'B  失去订金', .64, 3.44, 9.25, result)
    d.button(cancel, '返回邮件', .64, 4.72, 3.5, email, quiet=True)
    reveal = d.text(result, '10 days < 14 days\n错过免费取消的通知窗口，邮件说明订金会被扣留。', .64, 2.65, 11.56, 1.63, size=27, fill=d.soft, bold=True)
    d.reveal(result, reveal)
    d.button(result, '若刚好提前 14 天？', .64, 4.77, 4.65, terms)
    d.pair(terms, 'AT LEAST 14 DAYS\n14 天刚好达到下限。若只有 10 天则未达到。', 'EXTERNAL PHOTOGRAPHERS\n场地能推荐外部摄影师。自有摄影人员和预约均需另查。', size=22)
    d.button(terms, '回到取消题', .64, 5.18, 3.45, cancel, quiet=True)
    d.button(terms, '迁移到另一份通知 →', 4.34, 5.18, 4.97, transfer)

    d.pair(transfer, 'MONDAY · FIRST NOTICE\nFriday tour · Room 204\nRegister by Wednesday noon.', 'TUESDAY · UPDATE\nMeet in the library lobby.\nThe deadline stays the same.', size=23)
    d.button(transfer, '对答案 →', .64, 5.24, 3.5, model)
    reveal = d.text(model, 'Sign up by Wednesday at noon.\nMeet in the library lobby on Friday.', .64, 2.64, 11.55, 1.70, size=29, fill=d.soft, bold=True)
    d.reveal(model, reveal)
    d.button(model, '试写三行出口卡 →', .64, 4.82, 4.5, final)
    d.button(model, '返回两张通知', 5.44, 4.82, 4, transfer, quiet=True)
    d.text(final, 'Purpose       这条消息要达成什么？\nAction          读者具体要做什么？\nEvidence     哪一行文字足以支持你的判断？', .64, 2.52, 11.65, 2.44, size=27, fill=d.soft)
    d.button(final, '返回课程导航', .64, 5.28, 4.4, home)
    return d.finish(destination)


def chart(slide, target):
    data = CategoryChartData()
    data.categories = [row['en'] for row in TRAVEL_DATA]
    data.add_series('1990', tuple(row['values'][0] for row in TRAVEL_DATA))
    data.add_series('2010', tuple(row['values'][1] for row in TRAVEL_DATA))
    shape = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(.65), Inches(2.36), Inches(8.98), Inches(3.85), data)
    shape.click_action.target_slide = target
    model = shape.chart
    model.has_legend = True
    model.legend.position = XL_LEGEND_POSITION.BOTTOM
    model.legend.include_in_layout = False
    model.value_axis.minimum_scale = 0
    model.value_axis.maximum_scale = 14
    model.value_axis.major_unit = 2
    model.value_axis.tick_labels.font.size = Pt(11)
    model.category_axis.tick_labels.font.size = Pt(14)
    for series, color in zip(model.series, ('659383', '8D73B4')):
        series.format.fill.solid()
        series.format.fill.fore_color.rgb = RGBColor.from_string(color)


def ielts_deck(locator, destination):
    d = Deck('IELTS', '从读图到写概述', locator, [
        ('从读图到写概述', 'Academic Writing Task 1 · 儿童上学出行方式'),
        ('这张图到底在数什么？', '纵轴是每年出行次数，以百万次计。先找年份，再对单位。'),
        ('榜首与差值', '同年比名次，跨年比变化。二者各看一个维度。'),
        ('哪一句适合放在概述？', '请投票。A 报数字，B 概括变化，C 解释原因。'),
        ('概述揭晓', '找出回答里的名次反转与总体趋势。'),
        ('返回重选', '检查：这一句覆盖整体了吗？信息能在图里找到吗？'),
        ('用两个细节段组织数据', '选句子时说明它属于主变化还是其他下降类别。'),
        ('数据怎样支撑比较？', '把有代表性的数值放入细节，使用正确单位。'),
        ('打开考官视角', '先根据课堂讲解预测，再点各样例查看考官关注点。'),
        ('样例 1 · 概述与依据', '考官肯定了主要变化和末段概述，部分描述缺少数据。'),
        ('样例 2 · 覆盖与组织', '考官指出遗漏了步行加公交，并且组织不够清楚。'),
        ('写一段，交换检查', '先写概述和一个细节段。由同伴复述你的观察。'),
        ('换一张训练图', '判断：哪些涨、哪些跌、哪些基本不变？'),
        ('迁移揭晓', '分清次数与份额，使用稳定与变化的表达。'),
    ])
    home, visual, rank, vote, yes, retry, group, precision, review, first, second, write, transfer, model = d.slides
    d.button(home, '读取图表 →', .64, 2.58, 4.36, visual)
    d.button(home, '打开考官点评 →', .64, 3.37, 4.36, review)
    d.button(home, '课堂写作 →', .64, 4.16, 4.36, write)
    d.text(home, 'Read the title and unit.\nCompare the main changes.\nGroup the supporting figures.\nRevise after peer feedback.', 5.38, 2.40, 6.97, 3.23, size=27, fill=d.soft, bold=True)

    chart(visual, rank)
    d.button(visual, '比较榜首 →', 9.92, 2.63, 2.77, rank)
    d.button(visual, '直接选概述', 9.92, 3.47, 2.77, vote, quiet=True)
    d.text(visual, '教学重绘。原例文未附图，1990 年汽车为教学补值。', .64, 6.46, 12.00, .37, size=15, ink=d.accent)
    d.pair(rank, '1990 · 步行位列第一\n约 13 百万次', '2010 · 汽车位列第一\n约 11 百万次', size=28, height=1.75)
    reveal = d.text(rank, '步行下降最多：13 → 6（约少 7 百万次）', .64, 4.55, 11.6, .65, size=22, fill=d.soft, bold=True)
    d.reveal(rank, reveal)
    d.button(rank, '去选概述 →', 8.50, 5.47, 4.04, vote)
    d.button(vote, 'A  About 13 million trips were made on foot in 1990.', .64, 2.60, 11.8, retry, quiet=True)
    d.button(vote, 'B  Car travel overtook walking, while the other modes all declined.', .64, 3.34, 11.8, yes)
    d.button(vote, 'C  Car use rose because parents earned more.', .64, 4.08, 11.8, retry, quiet=True)
    d.button(vote, '返回图表', .64, 5.18, 3.59, visual, quiet=True)
    reveal = d.text(yes, 'Car travel overtook walking, while the other modes all declined.', .64, 2.62, 11.59, 1.21, size=27, fill=d.soft, bold=True)
    d.reveal(yes, reveal)
    d.button(yes, '去组织细节段 →', .64, 4.63, 4.62, group)
    d.pair(retry, '单个数值\n可作为细节证据。概述还有整体变化要交代。', '推测原因\n图里有出行次数，父母收入不在图表范围。', size=24, height=2)
    d.button(retry, '返回选项 →', .64, 5.04, 3.95, vote)

    left, right = d.pair(group, '主变化\n比较步行与汽车：谁降、谁升？', '其他下降项\n公交、骑行与步行加公交可归在一起。', size=24, height=1.93)
    left.click_action.target_slide = precision
    right.click_action.target_slide = precision
    d.button(group, '看考官点评 →', .64, 5.25, 4.50, review)
    d.pair(precision, 'DETAIL A\nWalking fell from about 13 to 6 million trips, while car trips rose from roughly 4 to 11 million.', 'DETAIL B\nBus use slipped to 5 million. Cycling and walk-plus-bus fell to 2 and 3 million respectively.', size=21, height=2.55)
    d.button(precision, '比较考官点评 →', .64, 5.43, 4.55, review)
    d.button(review, '打开样例 1 · 归纳到位 →', .64, 2.75, 8.2, first)
    d.button(review, '打开样例 2 · 遗漏关键信息 →', .64, 3.55, 8.2, second, quiet=True)
    d.text(review, '讨论：两份样例都能帮自己改什么？', .64, 4.73, 11.6, .55, size=22)
    d.text(first, '优点：主要变化清楚，末段有整体概述。\n可改：补数据支撑，把机械列数改成有目标的对比。', .64, 2.66, 11.56, 1.83, size=26, fill=d.soft)
    d.button(first, '查看样例 2 →', .64, 5.03, 4.08, second)
    d.button(first, '返回样例选择', 5.02, 5.03, 4.22, review, quiet=True)
    d.text(second, '优先补齐步行加公交。\n接着重组比较，最后修正词句和拼写。', .64, 2.66, 11.52, 1.83, size=27, fill=d.mark)
    d.button(second, '进入写作练习 →', .64, 5.03, 4.48, write)
    d.button(second, '对照样例 1', 5.40, 5.03, 3.65, first, quiet=True)

    d.pair(write, '写一段概述\n谁取代了谁？有几种交通方式下降？', '写一个比较段\n两组数字和单位能支撑你的判断吗？', size=25, height=1.85)
    d.button(write, '迁移到另一组数据 →', .64, 5.12, 5.32, transfer)
    d.pair(transfer, '2015 · 百万次\n步行 8   公交 5   骑行 2', '2025 · 百万次\n步行 6   公交 5   骑行 4', size=27, height=1.85)
    d.button(transfer, '对照概述 →', .64, 5.07, 4.52, model)
    reveal = d.text(model, 'Walking declined and cycling became more common, while bus use remained stable.', .64, 2.61, 11.66, 1.58, size=28, fill=d.soft, bold=True)
    d.reveal(model, reveal)
    d.button(model, '返回导航', .64, 4.76, 3.90, home)
    return d.finish(destination)


def render_pptx(track, locator, destination):
    return {'toefl': toefl_deck, 'ielts': ielts_deck}[track](locator, destination)
