export const claimLabels={number:'数字',experience:'亲历',cause:'因果'};
export const fieldLabels={spoken:'口播',subtitle:'字幕'};

const cues=[
  ['number',/\p{Nd}|(?:百分之|千分之|万分之)[零〇一二两三四五六七八九十百千万亿点]+|(?:[零〇一二两三四五六七八九十百千万亿]{2,}|[二两三四五六七八九十百千万亿])(?:多|余)?\s*(?:[%‰]|元|块钱|岁|倍|人|位|次|天|年|月|日|小时|分钟|秒|周|家|件|本|公里|公斤|吨|成)|一(?:倍|成|元|块钱|岁|公里|公斤|吨)/u],
  ['experience',/亲眼|亲耳|亲身|亲历|亲测|实测|(?:我们?|本人|咱们).{0,24}(?:曾经|当时|以前|昨天|上周|去年|每天|体验过|用过|看过|见过|遇到过|做过|采访过|试过|经历过|实拍过)/u],
  ['cause',/因为|所以|因此|因而|由此|导致|造成|促成|归因于|归功于|使得|证明了|证实了|(?:让|使).{1,20}(?:提升|提高|增加|减少|改善|增长|降低|上升|下降)/u]
];

function sentences(text) {
  return text.split(/[。！？!?；;\r\n]+|\.(?=\s|$)/u).map(line=>line.trim()).filter(Boolean);
}

const leadingMarkup=/^(?:>\s*)+|^[-*+]\s+/u;
const quoteSpans=/“([^“”\r\n]+)”|「([^「」\r\n]+)」|"([^"\r\n]+)"/gu;
const wholeQuote=new RegExp('^(?:'+quoteSpans.source+')[。.!！？?]?$','u');
const attribution=/^(?:店主|摊主|志愿者|顾客|受访者|受访人|采访对象|当事人|用户|作者|员工|负责人)(?:说|说道|表示|回忆|补充)?\s*[:：]$/u;
const startsSentence=/(?:^|[。！？!?；;\r\n]|\.(?=\s))\s*$/u;

function sentenceKey(text) {
  return text.normalize('NFKC').replace(leadingMarkup,'')
    .replace(/^[“”‘’"']+|[“”‘’"']+$/gu,'').trim();
}

function quoteBody(text) {
  const match=text.trim().match(wholeQuote);
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}

function attributedQuoteBody(line) {
  const text=line.trim().replace(leadingMarkup,'');
  for (const match of text.matchAll(quoteSpans)) {
    const suffix=text.slice(match.index+match[0].length).trim();
    if (!/^[。.!！？?]?$/.test(suffix)) continue;
    const prefix=text.slice(0,match.index).split(/[。！？!?]+|\.(?=\s|$)/u).at(-1).trim();
    return attribution.test(prefix) ? (match[1] ?? match[2] ?? match[3]).trim() : null;
  }
  return null;
}

function quoteKey(text) {
  return text.normalize('NFKC').trim().replace(/[。.!?]+$/u,'').trim();
}

const quoteDelimiters=new Map([['“','”'],['「','」'],['『','』'],['"','"']]);
const terminalPunctuation=/[。！？.!?]$/u;
const sourceBoundary=/[：:。！？.!?\r\n]\s*$/u;

export function directQuoteOpening(shot,materials) {
  const passages=new Set();
  for (const {material,quote} of shot.evidence) {
    const source=materials.find(item=>item.id===material)?.content;
    if (!source?.includes(quote)) continue;
    for (const match of source.matchAll(quoteSpans)) {
      const passage=match[1]??match[2]??match[3];
      if (quote.includes(passage)) passages.add(passage);
    }
    const offset=source.indexOf(quote);
    if (terminalPunctuation.test(quote)&&(!offset||sourceBoundary.test(source.slice(0,offset)))) passages.add(quote);
  }
  const matches=[];
  for (const passage of passages) {
    const offset=shot.spoken.indexOf(passage);
    if (offset<0||offset>80) continue;
    const mark=shot.spoken[offset-1];
    const quoted=quoteDelimiters.has(mark)&&quoteDelimiters.get(mark)===shot.spoken[offset+passage.length];
    const start=quoted?offset-1:offset;
    if (start===0||quoted||/[：:]\s*$/u.test(shot.spoken.slice(0,start))) matches.push(start);
  }
  if (!matches.length) return null;
  const start=Math.min(...matches);
  if (!start) return shot;
  const lead=shot.spoken.slice(0,start);
  const subtitle=shot.subtitle.startsWith(lead)?shot.subtitle.slice(lead.length):shot.subtitle;
  return {...shot,spoken:shot.spoken.slice(start),subtitle};
}

function withoutCoveredQuotes(text,anchors) {
  return text.replace(quoteSpans,(full,curly,corner,straight,index)=>{
    if (!startsSentence.test(text.slice(0,index))) return full;
    return anchors.has(quoteKey(curly ?? corner ?? straight)) ? '。' : full;
  });
}

export function reviewScriptEvidence(result,materials) {
  const sources=new Map(materials.map(({id,content})=>[id,{
    sentences:new Set(sentences(content).map(sentenceKey)),
    quotes:new Set(content.split(/\r\n?|\n/u).map(attributedQuoteBody).filter(Boolean).map(quoteKey))
  }]));
  return result.segments.flatMap((shot,index)=>{
    const anchors=new Set();
    const quotedAnchors=new Set();
    for (const {material,quote} of shot.evidence) {
      const source=sources.get(material);
      if (!source) continue;
      for (const key of sentences(quote).map(sentenceKey)) {
        if (source.sentences.has(key)) anchors.add(key);
      }
      const key=quoteKey(quoteBody(quote) ?? attributedQuoteBody(quote) ?? quote);
      if (source.quotes.has(key)) quotedAnchors.add(key);
    }
    const flagged=new Map();
    for (const field of Object.keys(fieldLabels)) {
      const remaining=quotedAnchors.size ? withoutCoveredQuotes(shot[field],quotedAnchors) : shot[field];
      for (const text of sentences(remaining)) {
        const key=sentenceKey(text);
        const kinds=cues.filter(([,pattern])=>pattern.test(key)).map(([kind])=>kind);
        if (!kinds.length || anchors.has(key)) continue;
        const existing=flagged.get(key);
        if (!existing) flagged.set(key,{text,fields:[field],kinds});
        else if (!existing.fields.includes(field)) existing.fields.push(field);
      }
    }
    return flagged.size?[{index,statements:[...flagged.values()]}]:[];
  });
}

export function evidenceReviewNotes(review) {
  return review.flatMap(({index,statements})=>statements.map(({text,fields,kinds})=>
    '第 '+(index+1)+' 镜'+fields.map(field=>fieldLabels[field]).join('和')+' · '+
    kinds.map(kind=>claimLabels[kind]).join('、')+'待核对原文 ｜ '+text));
}
