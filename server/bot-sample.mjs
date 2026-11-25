import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Problem, heading, message, sha, textFile } from './contracts.mjs';

export const sampleFixtureInput = z.strictObject({
  title:heading, prompt:message, files:z.array(textFile).min(1).max(6),
  expectedQuote:z.string().trim().min(1).max(460).optional(),
  useInChat:z.boolean().default(false), authorized:z.literal(true)
});

export function sampleDigest({title,prompt,files,expectedQuote,useInChat}) {
  return sha(JSON.stringify({title,prompt,files,expectedQuote,useInChat}));
}

export function checkedSample(fixture,kind) {
  if (!fixture) return undefined;
  const {authorized,...spec}=fixture;
  if (kind==='brief' && spec.files.length<2) {
    throw new Problem(422,'素材简报的验证样例至少需要两份文字材料。','sample_materials');
  }
  const files=spec.files.map(file=>({...file,content:file.content.replace(/\r\n?/g,'\n')}));
  if (new Set(files.map(file=>file.name.normalize('NFC').toLowerCase())).size!==files.length) {
    throw new Problem(422,'请为验证样例选择不同名称的材料。','sample_materials');
  }
  if (files.some(file=>Buffer.byteLength(file.content)>64000) ||
      files.reduce((total,file)=>total+Buffer.byteLength(file.content),0)>128000) {
    throw new Problem(422,'单份样例文字最多 64 KB，合计最多 128 KB。','sample_materials');
  }
  const expectedQuote=spec.expectedQuote?.replace(/\r\n?/g,'\n');
  if (expectedQuote && !files.some(file=>file.content.includes(expectedQuote))) {
    throw new Problem(422,'指定引用须是样例材料的连续原文。','sample_reference');
  }
  const checked={...spec,files,expectedQuote};
  return {...checked,digest:sampleDigest(checked)};
}

function identify(files) {
  return files.map(file=>({...file,id:randomUUID()}));
}

export const makeSamples = () => identify([
  { name:'店主访谈.txt', content:'【合成演练材料】\n店主说：“我每天先把门口那排书摆好，再开灯。”\n书店是街角的一家独立书店。' },
  { name:'拍摄笔记.md', content:'【合成演练材料】\n先拍钥匙转动和门把手，再拍店主把书一排排摆齐。开灯时拍到书架由暗变亮。末镜拍翻开的书页，留一点翻书声。' }
]);

export function materializeExample(bot,{verification=false}={}) {
  const sample=bot.fixture;
  if (sample) {
    if (!verification && !sample.useInChat) throw new Problem(422,'此 Bot 的样例用于候选版本验证。','sample_scope');
    if (sampleDigest(sample)!==sample.digest) throw new Problem(409,'样例内容与登记摘要不一致。','sample_integrity');
    return {title:sample.title,prompt:sample.prompt,materials:identify(sample.files),expectedQuote:sample.expectedQuote};
  }
  const prompt=bot.kind==='script'
    ? '把两份材料写成约 45 秒的口播分镜。开场用店主原话，按开门、摆书、开灯、翻书四镜安排，每一镜写口播、画面和字幕。'
    : '综合访谈和拍摄笔记，归纳已确认的做法和仍需核对的问题。';
  return {title:'书店合成样例',prompt,materials:makeSamples()};
}

export function checkSampleResult(output,expectedQuote) {
  if (expectedQuote && !(output.segments??output.points).some(row=>row.evidence.some(link=>link.quote.includes(expectedQuote)))) {
    throw new Problem(422,'成果通过了引用校验，但没有引用样例指定的原文。','sample_reference');
  }
}

