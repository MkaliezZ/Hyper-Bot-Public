import type { OpsEnrollment, OpsFollowUp, OpsTrack } from './operations.js';

export type StudentStatus = 'active' | 'paused' | 'archived';
export type StudentProfileInput = {
  name: string;
  code: string | null;
  className: string | null;
  track: OpsTrack;
  status: StudentStatus;
};
export type StudentProfile = StudentProfileInput & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type StudentEnrollmentCandidate = Pick<OpsEnrollment, 'id' | 'label' | 'track' | 'endOn' | 'state'> & {
  studentId: string | null;
};
export type StudentArtifact = {
  artifactId: string;
  taskId: string;
  projectId: string;
  kind: 'lesson' | 'practice_pack';
  title: string;
  version: number;
};
export type LearningLinkStatus = 'reference' | 'used' | 'assigned' | 'completed';
export type StudentLearningLinkInput = {
  artifactId: string;
  status: LearningLinkStatus;
  occurredOn: string | null;
  note: string;
};
export type StudentLearningLink = StudentLearningLinkInput & {
  updatedAt: string;
  artifact: StudentArtifact;
};
export type StudentDirectory = {
  students: StudentProfile[];
  enrollments: StudentEnrollmentCandidate[];
  artifacts: StudentArtifact[];
};
export type StudentDetail = {
  student: StudentProfile;
  enrollments: Array<OpsEnrollment & { followUps: OpsFollowUp[] }>;
  learning: StudentLearningLink[];
};
