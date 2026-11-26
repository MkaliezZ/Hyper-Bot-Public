"""Bounded text extraction and source-linked exercise targets."""

from dataclasses import asdict, dataclass
from pathlib import Path
import re
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
import pymupdf
from pptx import Presentation

from local_lesson import WORD_NS


class PracticeProblem(Exception):
    pass


MAX_TEXT = 28000
MAX_AUTO_PAGES = 12
MAX_SELECTED_PAGES = 20
MAX_BYTES = 32 * 1024 * 1024
WORD = re.compile(r"[a-z]+(?:['’-][a-z]+)*", re.I | re.ASCII)
NUMBER = re.compile(r'\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b', re.I)
SENTENCES = re.compile(r"(?<!\bMr\.)(?<!\bMs\.)(?<!\bDr\.)(?<=[.!?])\s+(?=[A-Z0-9])|[。！？；]")
TEXT_RULES = [
    ('deadline', '报名或提交的截止时间', r'\bby\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tonight|tomorrow|noon|midnight)\b|\d{1,2}(?::\d{2})?(?:\s*(?:am\b|pm\b|a\.m\.|p\.m\.))?)'),
    ('date', '指定日期和星期', r'\bon\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b'),
    ('clock', '钟点和集合时间', r'\bat\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am\b|pm\b|a\.m\.|p\.m\.)?)'),
    ('conditional', '区分条件与结果', r'\b(?:if|unless)\b[^,.;?!]{3,90},\s*[^.!?;]{5,180}'),
    ('cause', '找出原因与结果', r'\b(?:because|as a result|therefore|due to|so that)\b'),
    ('order', '理解步骤或事件先后', r'\b(?:first|next|then|finally|after that|before that|in the end)\b'),
    ('direction', '理解英语指路信息', r'\b(?:turn left|turn right|go straight|walk past|across from|next to|on your left|on your right)\b'),
    ('comparison', '理解比较和数量关系', r'\b(?:more than|fewer than|less than|at most|at least|as many as)\b'),
]
FOCUS_WORDS = {
    'deadline': ('截止', '报名', '期限', 'deadline', 'by'), 'date': ('日期', '星期', 'date'),
    'clock': ('时间', '几点', 'time'), 'conditional': ('条件', 'if', 'unless'),
    'cause': ('因果', '原因', 'because'), 'direction': ('指路', '地图', 'route', 'directions'),
    'order': ('顺序', '步骤', 'order'), 'comparison': ('比较', '数量', 'comparison'),
    'number': ('数字', '数量', 'number'), 'vocabulary': ('词汇', '语块', 'vocabulary'),
    'reading': ('主旨', '理解', '阅读', '证据', 'reading', 'evidence'),
}
STOP = set("""about again also always another around because before between could every first
from have here into just last many more much must never next only other over people please said
same should some still such than that their them then there these they thing think those three
through time under until very want well went were what when where which while will with would
write your yours this which dialogue grammar read answer exercise students teacher listening
reading practice lesson unit learning class question activity lesson example group today""".split())
STOP.update({
    'school', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
})


@dataclass
class Target:
    id: str
    label: str
    category: str
    objective: str
    evidence: str
    locator: str
    kind: str
    value: str
    block: int


def source_units(path, pages):
    suffix = path.suffix.lower()
    if suffix in {'.png', '.jpeg', '.jpg', '.webp'}:
        raise PracticeProblem('PRACTICE_TEXT_REQUIRED')
    if path.stat().st_size > MAX_BYTES:
        raise PracticeProblem('PRACTICE_INVALID')

    if suffix == '.pdf':
        with pymupdf.open(path) as doc:
            if not doc.is_pdf or doc.needs_pass or not len(doc):
                raise PracticeProblem('PRACTICE_INVALID')
            if pages == 'auto':
                first, last = 1, min(MAX_AUTO_PAGES, len(doc))
            else:
                parsed = re.fullmatch(r'(\d{1,3})-(\d{1,3})', pages)
                if not parsed:
                    raise PracticeProblem('PRACTICE_PAGES')
                first, last = map(int, parsed.groups())
                if not 1 <= first <= last <= len(doc) or last - first >= MAX_SELECTED_PAGES:
                    raise PracticeProblem('PRACTICE_PAGES')
            label = f'PDF 第 {first} 页' if first == last else f'PDF 第 {first}–{last} 页'
            units = ((f'PDF 第 {i + 1} 页', doc[i].get_text(sort=True)) for i in range(first - 1, last))
            return label, extract(units)

    if suffix in {'.txt', '.md'}:
        content = path.read_bytes()
        if b'\x00' in content:
            raise PracticeProblem('PRACTICE_INVALID')
        try:
            body = content.decode('utf-8-sig')
        except UnicodeDecodeError:
            body = content.decode('gb18030')
        label = '文本材料' if suffix == '.txt' else 'Markdown 材料'
        units = (
            (f'第 {i} 行', re.sub(r'^\s{0,3}#{1,6}\s+', '', line))
            for i, line in enumerate(body.splitlines(), 1)
        )
        return label, extract(units)

    if suffix in {'.docx', '.pptx'}:
        with ZipFile(path) as package:
            entries = package.infolist()
            if len(entries) > 2000 or sum(item.file_size for item in entries) > 120 * 1024 * 1024:
                raise PracticeProblem('PRACTICE_INVALID')
            if suffix == '.docx':
                info = package.getinfo('word/document.xml')
                if info.file_size > 8 * 1024 * 1024:
                    raise PracticeProblem('PRACTICE_INVALID')
                doc = fromstring(package.read(info))
                units = (
                    (f'Word 第 {i} 段', ''.join(run.text or '' for run in para.iter(f'{WORD_NS}t')))
                    for i, para in enumerate(doc.iter(f'{WORD_NS}p'), 1)
                )
                return 'Word 正文与表格', extract(units)
            if 'ppt/presentation.xml' not in package.namelist():
                raise PracticeProblem('PRACTICE_INVALID')
        return 'PPTX 幻灯片正文与表格', extract(slide_units(Presentation(path)))

    raise PracticeProblem('PRACTICE_INVALID')


def slide_units(deck):
    for i, slide in enumerate(deck.slides, 1):
        for shape in slide.shapes:
            if shape.has_text_frame:
                yield f'幻灯片第 {i} 页', shape.text
            elif shape.has_table:
                for row in shape.table.rows:
                    yield f'幻灯片第 {i} 页', ' | '.join(cell.text for cell in row.cells)


def extract(units):
    blocks = []
    used = 0
    seen = set()
    for locator, raw in units:
        visible = ' '.join(re.sub(r'[\x00-\x1f]', ' ', raw[:MAX_TEXT]).split())
        for sentence in SENTENCES.split(visible):
            line = sentence.strip()
            words = WORD.findall(line)
            if len(words) < 3 or len(line) > 1100 or line.casefold() in seen:
                continue
            blocks.append(dict(locator=locator, text=line))
            seen.add(line.casefold())
            used += len(line)
            if used >= MAX_TEXT or len(blocks) >= 140:
                return blocks
    return blocks


def focus_score(focus, target):
    terms = {word.casefold() for word in WORD.findall(focus)}
    english_in_source = terms.intersection(word.casefold() for word in WORD.findall(target.evidence))
    chinese_focus = any(word in focus for word in FOCUS_WORDS.get(target.kind, ()) if not word.isascii())
    english_focus = terms.intersection(FOCUS_WORDS.get(target.kind, ()))
    anchor_focus = terms.intersection(word.casefold() for word in WORD.findall(target.value))
    return len(english_in_source) + 3 * bool(english_focus or chinese_focus) + 4 * bool(anchor_focus)


def build_targets(blocks, focus):
    candidates = []
    seen = set()

    def add(index, kind, label, value, objective, category='语言知识'):
        key = kind, value.casefold()
        if key in seen:
            return
        seen.add(key)
        block = blocks[index]
        target = Target('', label, category, objective, block['text'], block['locator'], kind, value, index)
        source_priority = 1 if kind in {'vocabulary', 'reading'} else 3
        candidates.append(((focus_score(focus, target), source_priority), target))

    for i, block in enumerate(blocks):
        text = block['text']
        if len(text) > 500:
            continue
        words = WORD.findall(text)
        title_like = not text.endswith(('.', '!', '?')) and sum(word[0].isupper() for word in words) > len(words) / 2
        time_ranges = []
        for kind, label, expression in TEXT_RULES:
            match = re.search(expression, text, re.I)
            if match:
                value = match[0].strip()
                add(i, kind, label, value, f'能结合原句理解 {value} 的作用，并在新上下文中用对。')
                if kind in {'deadline', 'clock'}:
                    time_ranges.append(match.span())
        number = next((match for match in NUMBER.finditer(text)
                       if not any(start <= match.start() < end for start, end in time_ranges)), None)
        if number:
            add(i, 'number', f'准确提取数量或时间 {number[0]}', number[0], '能记录数字并说明它在材料中指代什么。', '读写技能')
        options = [word for word in words if len(word) >= 5 and word.casefold() not in STOP]
        options.sort(key=lambda word: (word.casefold() in focus, words.count(word)), reverse=True)
        if options and not title_like:
            word = options[0]
            add(i, 'vocabulary', f'在语境中理解 {word}', word, f'能结合前后文说明 {word} 在这句话里的作用。')
        if len(words) >= 5 and not title_like:
            short_value = text[:list(WORD.finditer(text))[4].end()]
            value = options[0] if options else short_value
            add(i, 'reading', f'提取信息 · {short_value}', value, '能归纳这条信息，并定位支持结论的原句。', '读写技能')

    candidates.sort(key=lambda ranked: ranked[0], reverse=True)
    selected = []
    counts = {}
    best_by_kind = {}
    for _, target in candidates:
        best_by_kind.setdefault(target.kind, target)
    prioritized = list(best_by_kind.values())
    prioritized.extend(target for _, target in candidates if target is not best_by_kind[target.kind])
    for target in prioritized:
        seen_count = counts.get(target.kind, 0)
        if seen_count >= (3 if target.kind in {'reading', 'vocabulary'} else 2):
            continue
        if seen_count >= 1 and len(selected) >= 8:
            continue
        counts[target.kind] = seen_count + 1
        selected.append(target)
        if len(selected) == 12:
            break
    for number, target in enumerate(selected, 1):
        target.id = f'target-{number}'
    return selected


def analyze(path: Path, filename, pages, focus):
    label, blocks = source_units(path, pages)
    targets = build_targets(blocks, focus.casefold())
    if not targets:
        raise PracticeProblem('PRACTICE_TEXT_REQUIRED')
    name = Path(filename.replace('\\', '/')).name[:150]
    return dict(
        title=f'{Path(name).stem[:75]} · 知识点识别',
        source=f'{name} · {label}',
        material=Path(name).stem[:75],
        blocks=blocks,
        targets=[asdict(target) for target in targets],
    )
