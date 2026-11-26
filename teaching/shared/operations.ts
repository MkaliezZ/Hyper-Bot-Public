export type OpsTrack = 'k12' | 'toefl' | 'ielts';
export type OpsAudience = OpsTrack | 'all';
export type OpsMode = 'live' | 'demo';
export const opsTrackLabels: Record<OpsAudience, string> = { all: '全课程', k12: 'K12 英语', toefl: '托福', ielts: '雅思' };

export type OpsCalendarItem = {
  id: string;
  title: string;
  track: OpsAudience;
  date: string;
  leadDays: number;
  recurrence: 'once' | 'annual';
  status: 'confirmed' | 'tentative' | 'done';
  sourceUrl: string;
  details: string;
};
export type OpsCalendarCard = OpsCalendarItem & {
  nextOn: string;
  daysUntil: number;
  phase: 'prepare' | 'upcoming' | 'today' | 'overdue' | 'done' | 'tentative';
  recommendation: string;
};

export type OpsSignal = {
  id: string;
  kind: 'policy' | 'hotspot';
  title: string;
  track: OpsAudience;
  region: string;
  sourceUrl: string;
  publishedOn: string;
  effectiveOn: string | null;
  status: 'unverified' | 'verified' | 'dismissed';
  facts: string;
  reviewNotes: string;
};
export type OpsSignalCard = OpsSignal & {
  officialSource: boolean;
  sourceHost: string;
  actionStatus: 'needs_review' | 'ready' | 'archived';
  recommendation: string;
};

export type OpsFeedback = 'unknown' | 'positive' | 'neutral' | 'concern';
export type OpsIssue = 'none' | 'schedule' | 'learning' | 'payment' | 'other';
export type OpsRenewalState = 'unpaid' | 'planned' | 'paid' | 'opt_out' | 'paused' | 'dispute';
export type OpsEnrollment = {
  id: string;
  label: string;
  track: OpsTrack;
  endOn: string | null;
  remainingLessons: number | null;
  attendancePct: number | null;
  feedback: OpsFeedback;
  issue: OpsIssue;
  state: OpsRenewalState;
  contactAllowed: boolean;
  lastContactOn: string | null;
};
export type OpsHistoryRow = {
  id: string;
  track: OpsTrack;
  asOf: string;
  endOn: string;
  observedThrough: string;
  renewed: boolean | null;
  arm: 'standard' | 'extra' | 'unknown';
  randomized: boolean;
  experimentId?: string | null;
  feedback: OpsFeedback;
  attendancePct: number | null;
  state: 'unpaid' | 'planned';
};
export type OpsEstimate = {
  estimate: number;
  low: number;
  high: number;
  support: number;
  scope: string;
};
export type OpsRenewalCard = {
  enrollment: OpsEnrollment;
  studentId?: string;
  daysUntil: number | null;
  priority: 'service' | 'urgent' | 'watch' | 'routine' | 'closed' | 'missing';
  reasons: string[];
  recommendation: string;
  probability: OpsEstimate | null;
  uplift: OpsEstimate | null;
  probabilityStatus: string;
  upliftStatus: string;
};
export type OpsModelSummary = {
  matureRows: number;
  validationRows: number;
  brier: number | null;
  baselineBrier: number | null;
  probabilityStatus: string;
  randomizedRows: number;
  upliftStatus: string;
};
export type OpsFollowUp = {
  date: string;
  outcome: 'contacted' | 'payment_planned' | 'no_response' | 'paused' | 'resolved';
  note: string;
};
export type OpsDashboard = {
  mode: OpsMode;
  today: string;
  timezone: string;
  calendar: OpsCalendarCard[];
  signals: OpsSignalCard[];
  renewals: OpsRenewalCard[];
  history: OpsModelSummary;
  followUps: Record<string, OpsFollowUp[]>;
};
