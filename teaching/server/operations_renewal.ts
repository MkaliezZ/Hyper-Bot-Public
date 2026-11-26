import { opsTrackLabels } from '../shared/operations.js';
import type { OpsEnrollment, OpsEstimate, OpsFeedback, OpsHistoryRow, OpsModelSummary, OpsRenewalCard } from '../shared/operations.js';

const DAY_MS = 86_400_000;
const HORIZON = 14;
const MIN_TRAINING = 24;
const MIN_VALIDATION = 12;
const MIN_ARM = 30;
const CONFIDENCE_Z = 1.96;

type RenewalFeatures = Pick<OpsHistoryRow, 'track' | 'feedback' | 'state'>;
type Closed = OpsHistoryRow & { renewed: boolean; snapshotDay: number; observedDay: number };
type Cohort = { key: string; label: string };
type ProbabilityModel = {
  rates: Map<string, OpsEstimate>;
  validationRows: number;
  brier: number | null;
  baselineBrier: number | null;
  status: string;
};

const feedbackLabels: Record<OpsFeedback, string> = { positive: '反馈正向', neutral: '反馈中性', concern: '反馈有顾虑', unknown: '反馈待补充' };
const issueLabels = { schedule: '排课安排', learning: '课程或学习体验', payment: '支付环节', other: '登记的问题' };
const priorityOrder: Record<OpsRenewalCard['priority'], number> = { service: 0, urgent: 1, missing: 2, watch: 3, routine: 4, closed: 5 };

function day(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / DAY_MS : null;
}

function completeHistory(rows: OpsHistoryRow[], today: number): Closed[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const closed: Closed[] = [];
  for (const row of rows) {
    const snapshotDay = day(row.asOf);
    const endDay = day(row.endOn);
    const observedDay = day(row.observedThrough);
    if (counts.get(row.id) !== 1 || typeof row.renewed !== 'boolean' || snapshotDay === null || endDay === null || observedDay === null) continue;
    if (endDay - snapshotDay !== HORIZON || observedDay < endDay + HORIZON || observedDay > today) continue;
    closed.push({ ...row, snapshotDay, observedDay, renewed: row.renewed });
  }
  return closed;
}

function countRenewed(rows: Closed[]) {
  return rows.reduce((count, row) => count + Number(row.renewed), 0);
}

function wilson(success: number, sample: number) {
  const proportion = success / sample;
  const z2 = CONFIDENCE_Z ** 2;
  const center = (proportion + z2 / (2 * sample)) / (1 + z2 / sample);
  const margin = CONFIDENCE_Z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * sample)) / sample) / (1 + z2 / sample);
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function cohorts({ track, feedback, state }: RenewalFeatures): Cohort[] {
  const course = opsTrackLabels[track];
  const profile = `${course} · ${feedbackLabels[feedback]}`;
  return [
    { key: `${track}/${feedback}/${state}`, label: `${profile} · ${state === 'planned' ? '已登记付款计划' : '待续费'}` },
    { key: `${track}/${feedback}`, label: profile },
    { key: track, label: course },
    { key: 'all', label: '全课程' },
  ];
}

function groups(rows: Closed[]) {
  const result = new Map<string, { cohort: Cohort; rows: Closed[] }>();
  for (const row of rows) {
    for (const cohort of cohorts(row)) {
      let group = result.get(cohort.key);
      if (!group) {
        group = { cohort, rows: [] };
        result.set(cohort.key, group);
      }
      group.rows.push(row);
    }
  }
  return result;
}

function brier(rows: Closed[], predictiveRate: (row: Closed) => number) {
  return rows.reduce((sum, row) => sum + (predictiveRate(row) - Number(row.renewed)) ** 2, 0) / rows.length;
}

function probabilityModel(closed: Closed[]): ProbabilityModel {
  const ordinary = closed.filter(row => row.arm === 'standard').sort((a, b) => a.snapshotDay - b.snapshotDay);
  const splitDay = ordinary[Math.floor(ordinary.length * 0.7)]?.snapshotDay;
  const validation = ordinary.filter(row => row.snapshotDay >= splitDay);
  const training = ordinary.filter(row => row.observedDay < splitDay);
  const unavailable = { rates: new Map<string, OpsEstimate>(), validationRows: validation.length, brier: null, baselineBrier: null };
  if (training.length < MIN_TRAINING || validation.length < MIN_VALIDATION) {
    return { ...unavailable, status: `待积累完整的常规服务记录。至少需要 ${MIN_TRAINING} 条训练记录及 ${MIN_VALIDATION} 条时间留出验证记录。` };
  }

  const prior = countRenewed(training) / training.length;
  const baseline = brier(validation, () => prior);
  const fits = groups(training);
  const tests = groups(validation);
  const rates = new Map<string, OpsEstimate>();
  for (const [key, { cohort, rows }] of fits) {
    const heldOut = tests.get(key)?.rows ?? [];
    if (rows.length < MIN_TRAINING || heldOut.length < MIN_VALIDATION) continue;
    const successes = countRenewed(rows);
    const validated = countRenewed(heldOut);
    if (Math.min(successes, rows.length - successes, validated, heldOut.length - validated) < 2) continue;
    const estimate = successes / rows.length;
    const bounds = wilson(successes, rows.length);
    const testBounds = wilson(validated, heldOut.length);
    if (bounds.low > testBounds.high || bounds.high < testBounds.low || Math.abs(estimate - validated / heldOut.length) > 0.2) continue;
    if (brier(heldOut, () => estimate) > brier(heldOut, () => prior) + 0.02) continue;
    rates.set(key, { ...bounds, estimate, support: rows.length, scope: `${cohort.label} · 常规服务历史队列` });
  }
  if (!rates.size) return { ...unavailable, baselineBrier: baseline, status: '已有留出记录，历史比率尚未通过稳定性验证。' };

  const evaluation = validation.filter(row => cohorts(row).some(cohort => rates.has(cohort.key)));
  const score = brier(evaluation, row => estimateFor(row, rates)!.estimate);
  const evaluationBaseline = brier(evaluation, () => prior);
  if (score > evaluationBaseline + 0.02) {
    return { ...unavailable, brier: score, baselineBrier: evaluationBaseline, status: '分组比率在时间留出上的误差高于全体基线，暂缓显示。' };
  }
  return {
    rates, validationRows: evaluation.length, brier: score, baselineBrier: evaluationBaseline,
    status: '常规服务历史比率已通过时间留出检查，可为到期前第 14 天的同类学员提供区间估计。',
  };
}

function estimateFor(features: RenewalFeatures, rates: Map<string, OpsEstimate>): OpsEstimate | null {
  for (const cohort of cohorts(features)) {
    const rate = rates.get(cohort.key);
    if (rate) return rate;
  }
  return null;
}

function randomizedGroups(closed: Closed[]) {
  const trials = new Map<string, Closed[]>();
  for (const row of closed) {
    if (!row.randomized || !row.experimentId?.trim() || row.arm === 'unknown') continue;
    const key = row.experimentId.trim();
    const rows = trials.get(key) ?? [];
    rows.push(row);
    trials.set(key, rows);
  }
  return trials;
}

function upliftFor(features: RenewalFeatures, trials: Map<string, Closed[]>): { estimate: OpsEstimate | null; status: string } {
  let matchedDates = -Infinity;
  let latest: OpsEstimate | null = null;
  for (const rows of trials.values()) {
    const ordinary = rows.filter(row => row.arm === 'standard' && row.track === features.track && row.feedback === features.feedback && row.state === features.state);
    const extra = rows.filter(row => row.arm === 'extra' && row.track === features.track && row.feedback === features.feedback && row.state === features.state);
    if (ordinary.length < MIN_ARM || extra.length < MIN_ARM) continue;
    ordinary.sort((a, b) => a.snapshotDay - b.snapshotDay);
    extra.sort((a, b) => a.snapshotDay - b.snapshotDay);
    const start = Math.max(ordinary[0].snapshotDay, extra[0].snapshotDay);
    const end = Math.min(ordinary.at(-1)!.snapshotDay, extra.at(-1)!.snapshotDay);
    if (end < start || end <= matchedDates) continue;
    const reference = ordinary.filter(row => row.snapshotDay >= start && row.snapshotDay <= end);
    const intervention = extra.filter(row => row.snapshotDay >= start && row.snapshotDay <= end);
    if (reference.length < MIN_ARM || intervention.length < MIN_ARM) continue;

    const baselineCount = countRenewed(reference);
    const extraCount = countRenewed(intervention);
    const baselineRate = baselineCount / reference.length;
    const extraRate = extraCount / intervention.length;
    const baselineBounds = wilson(baselineCount, reference.length);
    const extraBounds = wilson(extraCount, intervention.length);
    const difference = extraRate - baselineRate;
    const low = Math.max(-1, difference - Math.hypot(extraRate - extraBounds.low, baselineBounds.high - baselineRate));
    const high = Math.min(1, difference + Math.hypot(extraBounds.high - extraRate, baselineRate - baselineBounds.low));
    matchedDates = end;
    latest = { estimate: difference, low, high, support: reference.length + intervention.length,
      scope: `${cohorts(features)[0].label} · 同次随机分组的同期学员` };
  }
  if (!latest) return { estimate: null, status: `同类学员暂缺足量对照，每组至少需要 ${MIN_ARM} 条同期完成的随机分配记录。` };
  return { estimate: latest, status: latest.low > 0 ? '追加跟进在同类历史队列中有正向增益。' : latest.high < 0
    ? '同类历史队列中追加跟进的续费率更低。' : '区间包含零，当前难以确认追加跟进的作用。' };
}

function signalsFor(enrollment: OpsEnrollment, today: number, daysUntil: number | null): Pick<OpsRenewalCard, 'priority' | 'reasons' | 'recommendation'> {
  const { remainingLessons, attendancePct, feedback, issue, state, contactAllowed } = enrollment;
  const reasons: string[] = [];
  if (daysUntil === null) reasons.push('到期日待核对');
  else if (daysUntil < 0) reasons.push(`已超过到期日 ${-daysUntil} 天`);
  else if (daysUntil === 0) reasons.push('今天到期');
  else if (daysUntil <= 30) reasons.push(`距到期 ${daysUntil} 天`);
  if (remainingLessons !== null && remainingLessons <= 2) reasons.push(`剩余 ${remainingLessons} 课次`);
  if (attendancePct !== null && attendancePct < 70) reasons.push(`记录出勤率 ${Math.round(attendancePct)}%`);
  if (feedback === 'concern') reasons.push('最近反馈有顾虑');

  const result = (priority: OpsRenewalCard['priority'], recommendation: string, note?: string) =>
    ({ priority, recommendation, reasons: note ? [note, ...reasons] : reasons });
  if (state === 'paid') return result('closed', '核对收款和续期记录，关闭续费待办。', '已登记续费到账');
  if (state === 'dispute') return result('service', '交由服务负责人处理退款或争议，保留必要通知。', '存在待解决争议');
  if (state === 'opt_out' || !contactAllowed) return result('closed', '依机构规则提供必要服务通知。', '已拒绝追加跟进或未取得联系授权');
  if (state === 'paused') return result('watch', '由负责人确认暂停安排和恢复日期。', '课程暂停中');
  if (issue !== 'none') return result('service', `先处理${issueLabels[issue]}，确认障碍解决后再商议续课。`, `待处理${issueLabels[issue]}`);
  if (daysUntil === null) return result('missing', '先核对合同日期和剩余课次，再排续费计划。');
  if (state === 'planned') return result('routine', '按已约定的付款安排做常规提醒，到账后关闭待办。', '已登记付款计划');

  const lastContact = day(enrollment.lastContactOn);
  if (lastContact !== null && lastContact > today) return result('missing', '先核对未来日期的跟进记录，避免重复安排。', '跟进日期待核对');
  const dueUrgently = daysUntil <= 3 || (daysUntil <= 7 && (feedback === 'concern' || (remainingLessons !== null && remainingLessons <= 2)));
  if (lastContact !== null && today - lastContact < 3) return result(dueUrgently ? 'urgent' : 'watch', '先等候上次跟进反馈，按期发送必要服务提醒。', '三天内已主动联系');
  if (dueUrgently) {
    return result('urgent', '今天核对续课意愿与可选安排，由负责人审核下一步。');
  }
  if (daysUntil <= 14 || (remainingLessons !== null && remainingLessons <= 2) || feedback === 'concern' || (attendancePct !== null && attendancePct < 70)) {
    return result('watch', '在下一个提醒节点复核意愿、排课和服务反馈。');
  }
  return result('routine', daysUntil <= 30 ? '进入提前准备范围，可预先核对下期选项与可用时段。' : '按常规节奏核对课程进度和下个到期节点。');
}

export function assessRenewals(enrollments: OpsEnrollment[], history: OpsHistoryRow[], today: string): { renewals: OpsRenewalCard[]; history: OpsModelSummary } {
  const todayDay = day(today);
  if (todayDay === null) throw new RangeError('运营日期必须为有效的 YYYY-MM-DD。');
  const closed = completeHistory(history, todayDay);
  const model = probabilityModel(closed);
  const trials = randomizedGroups(closed);
  const renewals: OpsRenewalCard[] = enrollments.map(enrollment => {
    const endDay = day(enrollment.endOn);
    const daysUntil = endDay === null ? null : endDay - todayDay;
    const signals = signalsFor(enrollment, todayDay, daysUntil);
    const eligible = daysUntil === HORIZON && enrollment.contactAllowed && (enrollment.state === 'unpaid' || enrollment.state === 'planned');
    const hidden = daysUntil === null ? '到期日待补充。' : daysUntil !== HORIZON ? '以到期前第 14 天为统一估计时点。' : '当前联系授权或课程状态不适用。';
    if (!eligible) return { enrollment, daysUntil, ...signals, probability: null, uplift: null, probabilityStatus: hidden, upliftStatus: hidden };

    const features: RenewalFeatures = { track: enrollment.track, feedback: enrollment.feedback, state: enrollment.state === 'planned' ? 'planned' : 'unpaid' };
    const probability = estimateFor(features, model.rates);
    const uplift = upliftFor(features, trials);
    const lastContact = day(enrollment.lastContactOn);
    const maySuggest = enrollment.state === 'unpaid' && signals.priority === 'watch'
      && (lastContact === null || todayDay - lastContact >= 3);
    const priority = maySuggest && uplift.estimate && uplift.estimate.low > 0 ? 'urgent' : signals.priority;
    let recommendation = signals.recommendation;
    if (maySuggest && uplift.estimate && uplift.estimate.low > 0) recommendation = '同类历史学员受益于追加跟进，请负责人审核并安排一次针对性沟通。';
    if (maySuggest && uplift.estimate && uplift.estimate.high < 0) recommendation = '继续提供常规提醒和服务，复核续课需求。';
    return {
      enrollment, daysUntil, ...signals, priority, recommendation, probability, uplift: uplift.estimate,
      probabilityStatus: probability ? '以同类历史学员的续费频率估计，区间体现队列样本的不确定性。' : model.rates.size ? '该学员所在分组暂未通过验证。' : model.status,
      upliftStatus: uplift.status,
    };
  });
  renewals.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    || (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity) || a.enrollment.label.localeCompare(b.enrollment.label, 'zh'));

  return { renewals, history: {
    matureRows: closed.length, validationRows: model.validationRows, brier: model.brier, baselineBrier: model.baselineBrier,
    probabilityStatus: model.status,
    randomizedRows: [...trials.values()].reduce((sum, rows) => sum + rows.length, 0),
    upliftStatus: trials.size ? '按同次随机分配和同期入组评估追加跟进增益，当前支持范围见学员卡。' : '待积累有分组编号的随机分配及完整结果记录。',
  } };
}
