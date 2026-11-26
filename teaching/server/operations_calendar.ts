import { opsTrackLabels } from '../shared/operations.js';
import type { OpsAudience, OpsCalendarCard, OpsCalendarItem, OpsSignal, OpsSignalCard } from '../shared/operations.js';

const dayInMs = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const hotspotReviewDays = 14;
const officialDomains = ['gov.cn', 'neea.edu.cn', 'neea.cn', 'ets.org', 'toefl.cn', 'ielts.org', 'chinaielts.org', 'britishcouncil.org', 'ielts.idp.com'];

function dateTime(value: string): number {
  if (!datePattern.test(value)) return NaN;
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) return NaN;
  return result.getTime();
}

export function isOpsDate(value: string): boolean {
  return Number.isFinite(dateTime(value));
}

function daysFrom(today: string, date: string): number {
  return (dateTime(date) - dateTime(today)) / dayInMs;
}

function sourceHost(value: string): string {
  if (!/^https:\/\//i.test(value)) return '';
  try {
    const source = new URL(value);
    return source.protocol === 'https:' && !source.username && !source.password && !source.port && source.hostname.includes('.')
      ? source.hostname.replace(/\.$/, '')
      : '';
  } catch {
    return '';
  }
}

export function isOpsSourceUrl(value: string): boolean {
  return Boolean(sourceHost(value));
}

function isOfficialHost(host: string): boolean {
  return officialDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function isOfficialSource(value: string): boolean {
  return isOfficialHost(sourceHost(value));
}

function nextAnnualDate(date: string, today: string): string {
  if (date >= today) return date;
  const monthAndDay = date.slice(5);
  const currentYear = Number(today.slice(0, 4));
  // Feb 29 only recurs on leap years, including across a non-leap century.
  for (let year = currentYear; year <= Math.min(currentYear + 8, 9999); year++) {
    const candidate = `${String(year).padStart(4, '0')}-${monthAndDay}`;
    if (candidate >= today && isOpsDate(candidate)) return candidate;
  }
  return date;
}

const calendarPhaseRank: Record<OpsCalendarCard['phase'], number> = {
  today: 0, prepare: 1, overdue: 2, tentative: 3, upcoming: 4, done: 5,
};

function actionForCalendar(track: OpsAudience, title: string): string {
  if (track === 'toefl' || track === 'ielts') {
    if (/出分|送分|申请|成绩/.test(title)) return '核对考试机构和目标院校要求，更新出分、送分与申请截止的内部核对清单。';
    if (/题型|考纲|评分|政策|规则|机考|纸笔/.test(title)) return '请教研对照官方公告，按适用场次更新练习、讲义和答疑口径。';
    return '从正式报名渠道核对地区、场次及截止时间，整理报名材料与备考计划。';
  }
  if (track === 'k12') {
    if (/假期|寒假|暑假|放假|调休/.test(title)) return '核对本地校历和服务安排，准备排课变动说明与自主学习资料，交负责人核对适用要求。';
    if (/期中|期末|阶段|测评|学期/.test(title)) return '和教师确认评价节点，准备分层复习、学习回顾和家长答疑。';
    return '核对学校和本机构实际安排，明确负责老师，准备入学衔接、材料与家校答疑。';
  }
  return '确认影响课程、负责人和截止时间，列出需要提前更新的资料与服务安排。';
}

export function buildCalendar(items: OpsCalendarItem[], today: string): OpsCalendarCard[] {
  return items.filter(item => isOpsDate(item.date)).map((item): OpsCalendarCard => {
    const nextOn = item.recurrence === 'annual' && item.status !== 'done' ? nextAnnualDate(item.date, today) : item.date;
    const daysUntil = daysFrom(today, nextOn);
    const phase = item.status === 'done' ? 'done' : item.status === 'tentative' ? 'tentative'
      : daysUntil < 0 ? 'overdue' : daysUntil === 0 ? 'today' : daysUntil <= item.leadDays ? 'prepare' : 'upcoming';
    let recommendation: string;
    switch (phase) {
      case 'done':
        recommendation = '本节点已标记完成，保留记录供复盘。';
        break;
      case 'tentative':
        recommendation = '先核对日期与适用范围。对外公告或执行计划交负责人确认。';
        break;
      case 'overdue':
        recommendation = '节点已过，核对执行结果、遗漏或改期情况，再更新记录。';
        break;
      case 'upcoming':
        recommendation = `将于设定的提前 ${item.leadDays} 天进入准备清单。`;
        break;
      default:
        recommendation = `${phase === 'today' ? '今天到期。' : ''}${actionForCalendar(item.track, item.title)}`;
    }
    return { ...item, sourceUrl: sourceHost(item.sourceUrl) ? item.sourceUrl : '', nextOn, daysUntil, phase, recommendation };
  }).sort((a, b) => calendarPhaseRank[a.phase] - calendarPhaseRank[b.phase]
    || (a.phase === 'overdue' || a.phase === 'done' ? b.daysUntil - a.daysUntil : a.daysUntil - b.daysUntil)
    || a.id.localeCompare(b.id));
}

const signalStatusRank: Record<OpsSignalCard['actionStatus'], number> = { ready: 0, needs_review: 1, archived: 2 };

function actionForPolicy(signal: OpsSignal): string {
  const text = `${signal.title} ${signal.facts}`;
  if (/分制|评分|成绩单|成绩报告|过渡期/.test(text)) return '核对新版成绩口径和过渡安排，更新备考讲义与成绩问答。';
  if (/题型|纸笔|机考|考纲|考试结构/.test(text)) return '标记适用场次，排查受影响的讲义、模拟题和考前答疑。';
  if (/收费|退款|退费|费用|缴费/.test(text)) return '核对新旧收费口径及适用条件，更新报名、退费问答和内部清单。';
  if (/报名|考位|考点|场次|报考/.test(text)) return '把经核对的截止、场次与考点调整更新到日历和报名清单。';
  if (signal.track === 'k12') return '列出受影响的课程与服务安排，更新家校答疑和负责人清单。';
  return '列出变更事实、受影响环节和待确认事项，更新相应材料与答疑。';
}

function actionForSignal(signal: OpsSignal, today: string, host: string): Pick<OpsSignalCard, 'actionStatus' | 'recommendation'> {
  if (signal.status === 'dismissed') {
    return { actionStatus: 'archived', recommendation: '本条已归档，可从原记录回查。' };
  }
  if (!isOpsDate(signal.publishedOn) || signal.publishedOn > today) {
    return { actionStatus: 'needs_review', recommendation: '先核对发布日期与来源，确认可见范围后再拟定动作。' };
  }
  if (signal.kind === 'hotspot' && daysFrom(signal.publishedOn, today) > hotspotReviewDays) {
    return { actionStatus: 'archived', recommendation: '已离开本期热点观察窗口。如有新进展，请记录新来源和日期后重审。' };
  }
  if (!host || signal.status !== 'verified') {
    const recommendation = signal.kind === 'policy'
      ? '打开发布机构的原文，核对发布日期、生效时间、地区及适用对象，然后提交负责人复核。'
      : '核对原始报道或公开数据，确认事实和时效；把热点线索和已证实的事实分别记录。';
    return { actionStatus: 'needs_review', recommendation };
  }
  const track = opsTrackLabels[signal.track];
  if (signal.kind === 'hotspot') {
    return { actionStatus: 'ready', recommendation: `围绕${track}学员最关心的实际问题拟一条解读，附来源；先交负责人审核，再决定是否交给自媒体。` };
  }
  if (!isOfficialHost(host)) {
    return { actionStatus: 'needs_review', recommendation: '补充发布机构的官方原文，并确认适用地区与生效日期。' };
  }
  if (!signal.effectiveOn || !isOpsDate(signal.effectiveOn)) {
    return { actionStatus: 'needs_review', recommendation: '核对本地区生效日期以及适用对象，再将确认日期放入运营日历。' };
  }
  const nextStep = signal.effectiveOn > today ? '安排在生效前完成，并交负责人审核。' : '对照当前资料核验后，交负责人审核。';
  return {
    actionStatus: 'ready',
    recommendation: `按公告核对${signal.region}的${track}适用范围。${actionForPolicy(signal)}${nextStep}`,
  };
}

export function buildSignals(signals: OpsSignal[], today: string): OpsSignalCard[] {
  return signals.map((signal) => {
    const host = sourceHost(signal.sourceUrl);
    return {
      ...signal, sourceUrl: host ? signal.sourceUrl : '', sourceHost: host, officialSource: isOfficialHost(host),
      ...actionForSignal(signal, today, host),
    };
  }).sort((a, b) => signalStatusRank[a.actionStatus] - signalStatusRank[b.actionStatus]
    || b.publishedOn.localeCompare(a.publishedOn) || a.id.localeCompare(b.id));
}
