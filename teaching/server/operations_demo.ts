import type { OpsCalendarItem, OpsEnrollment, OpsFollowUp, OpsHistoryRow, OpsSignal, OpsTrack } from '../shared/operations.js';

function offset(date: string, days: number) {
  const time = Date.parse(date + 'T00:00:00Z') + days * 86400000;
  return new Date(time).toISOString().slice(0, 10);
}

function demoHistory(today: string): OpsHistoryRow[] {
  const rows: OpsHistoryRow[] = [];
  const tracks: OpsTrack[] = ['k12', 'toefl', 'ielts'];
  for (let month = 0; month < 10; month++) {
    const endOn = offset(today, -24 - month * 30);
    const asOf = offset(endOn, -14);
    for (const track of tracks) {
      for (const feedback of ['positive', 'concern'] as const) {
        for (const arm of ['standard', 'extra'] as const) {
          for (let index = 0; index < 10; index++) {
            const hits = feedback === 'positive' ? 8 : arm === 'extra' ? 6 : 3;
            rows.push({
              id: `demo-${month}-${track}-${feedback}-${arm}-${index}`,
              track, asOf, endOn, observedThrough: offset(endOn, 14), renewed: index < hits, arm, randomized: true,
              experimentId: 'demo-additional-follow-up', feedback, attendancePct: feedback === 'positive' ? 93 : 72,
              state: 'unpaid',
            });
          }
        }
      }
    }
  }
  return rows;
}

export function createOpsDemo(today: string) {
  const calendar: OpsCalendarItem[] = [
    { id: 'demo-term-review', title: 'K12 阶段学习回顾', track: 'k12', date: offset(today, 10), leadDays: 14,
      recurrence: 'once', status: 'confirmed', sourceUrl: '', details: '示例：教研准备形成性总结，运营核对现有课时与后续服务安排。' },
    { id: 'demo-ielts-cohort', title: '雅思考前答疑周', track: 'ielts', date: offset(today, 24), leadDays: 30,
      recurrence: 'once', status: 'confirmed', sourceUrl: '', details: '示例：内部核对班级节奏并准备考前答疑材料。考试日期由负责人另行核对。' },
    { id: 'demo-toefl-orientation', title: '托福阶段测评安排', track: 'toefl', date: offset(today, 31), leadDays: 14,
      recurrence: 'once', status: 'tentative', sourceUrl: '', details: '示例：待确认场地与任课老师，确认后再安排准备。' },
  ];
  const signals: OpsSignal[] = [
    { id: 'demo-score', title: '托福分数报告说明 · 政策核对样例', track: 'toefl', kind: 'policy', region: '国内考生',
      sourceUrl: 'https://www.ets.org/toefl/test-takers/ibt/scores/understand-scores.htm.html', publishedOn: offset(today, -2),
      effectiveOn: null, status: 'unverified', facts: '演示记录。官方链接供核对评分口径，演示日期不代表新公告发布时间。',
      reviewNotes: '核对适用考试日期、报告样式和国内报名口径后，再改答疑材料。' },
    { id: 'demo-hotspot', title: '开学后英语复习怎么安排 · 热点样例', track: 'k12', kind: 'hotspot', region: '机构内容选题',
      sourceUrl: '', publishedOn: offset(today, -1), effectiveOn: null, status: 'unverified',
      facts: '演示问题：家长询问开学后的听读练习与作业量，需先确认是否为反复出现的问题。',
      reviewNotes: '先核实提问是否具有代表性。可准备复习清单与常见问答。' },
  ];
  const enrollments: OpsEnrollment[] = [
    { id: 'demo-k12-041', label: 'K12 学员 041', track: 'k12', endOn: offset(today, 5), remainingLessons: 2,
      attendancePct: 72, feedback: 'concern', issue: 'schedule', state: 'unpaid', contactAllowed: true, lastContactOn: null },
    { id: 'demo-ielts-008', label: '雅思学员 008', track: 'ielts', endOn: offset(today, 14), remainingLessons: 3,
      attendancePct: 70, feedback: 'concern', issue: 'none', state: 'unpaid', contactAllowed: true, lastContactOn: null },
    { id: 'demo-toefl-019', label: '托福学员 019', track: 'toefl', endOn: offset(today, 10), remainingLessons: 5,
      attendancePct: 94, feedback: 'positive', issue: 'none', state: 'planned', contactAllowed: true, lastContactOn: offset(today, -4) },
    { id: 'demo-toefl-026', label: '托福学员 026', track: 'toefl', endOn: offset(today, 14), remainingLessons: 4,
      attendancePct: 94, feedback: 'positive', issue: 'none', state: 'unpaid', contactAllowed: true, lastContactOn: null },
    { id: 'demo-k12-012', label: 'K12 学员 012', track: 'k12', endOn: offset(today, 4), remainingLessons: 1,
      attendancePct: 79, feedback: 'neutral', issue: 'none', state: 'opt_out', contactAllowed: false, lastContactOn: null },
    { id: 'demo-ielts-003', label: '雅思学员 003', track: 'ielts', endOn: null, remainingLessons: null,
      attendancePct: null, feedback: 'unknown', issue: 'none', state: 'unpaid', contactAllowed: true, lastContactOn: null },
  ];
  const followUps: Record<string, OpsFollowUp[]> = {
    'demo-toefl-019': [{ date: offset(today, -4), outcome: 'payment_planned', note: '演示记录：已确认预计办理时间。' }],
  };
  return { calendar, signals, enrollments, history: demoHistory(today), followUps };
}
