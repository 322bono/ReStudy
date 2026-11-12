export type Region = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type Material = {
  initialContentJobId?: string | null;
  id: string;
  title: string;
  subject: string;
  kind: string;
  mime: string;
  bytes: number;
  pageCount: number;
  status: "uploaded" | "processing" | "ready" | "needs_review" | "error";
  progress: number;
  completedPages?: number;
  failedPage?: number | null;
  localOutline?: any;
  error?: string;
  warnings?: string[];
  sharedContextSummary?: {
    groups: number;
    complete: number;
    incomplete: number;
    linkedQuestions: number;
  };
  message?: string;
  paused?: boolean;
  selectedPages?: number[];
  tocPages?: number[];
  analysisRange?: string;
  excludedPages?: string;
  tocRange?: string;
  analysisMethod?: "auto" | "external" | "later";
  printedPageOffset?: number | null;
  createdAt: string;
  lastOpenedAt: string;
  hash: string;
};
export type TextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type Page = {
  number: number;
  width: number;
  height: number;
  text: string;
  kind: "content" | "answers" | "uncertain";
  manualKind?: boolean;
  items?: TextItem[];
};
export type Question = {
  mergedInto?: string | null;
  id: string;
  materialId: string;
  number: number;
  page: number;
  unit: string;
  text?: string;
  regions: Region[];
  confidence: number;
  confirmed: boolean;
  source: "text" | "ocr" | "manual";
  conceptIds: string[];
  hasContent: boolean;
  sharedRegionCount?: number;
};
export type Result = "correct" | "wrong" | "skip";
export type Mistake = {
  id: string;
  questionId: string;
  cause: string;
  createdAt: string;
  dueAt: string;
  streak: number;
  reviewCount: number;
  correctCount: number;
  lastResult?: Result;
  resolved?: boolean;
  resolvedAt?: string | null;
  conceptState: "unregistered" | "reviewing" | "understood";
  conceptAccuracy?: number;
};
export type Point = { x: number; y: number };
export type Stroke = {
  points: Point[];
  color: string;
  width: number;
  region: number;
};
export type SolveSession = {
  id: string;
  questionIds: string[];
  answers: Record<string, { result: Result; at: string; answerText?: string }>;
  drawings: Record<string, Stroke[]>;
  createdAt: string;
  status: "active" | "complete";
  questions?: Question[];
};
export type Source = { materialId: string; page: number };
export type Concept = {
  id: string;
  subject: string;
  major: string;
  minor: string;
  name: string;
  definition: string;
  properties: string[];
  misconceptions: { id: string; label: string; correction: string }[];
  sources: Source[];
};
export type StudyMode = "quiz" | "memory" | "check";
export type BankType =
  "객관식" | "OX" | "빈칸" | "단답형" | "서술형" | "플래시카드" | "문장 가리기";
export type BankItem = {
  id: string;
  conceptId: string;
  type: BankType;
  prompt: string;
  choices: string[];
  answer: string;
  acceptedAnswers: string[];
  explanation: string;
  choiceFeedback: Record<
    string,
    { explanation: string; misconceptionTag: string }
  >;
  correction: string;
  difficulty: "기본" | "보통" | "심화";
  sources: Source[];
  modes: StudyMode[];
  active: boolean;
};
export type StudyItem = Omit<
  BankItem,
  "answer" | "acceptedAnswers" | "explanation" | "choiceFeedback" | "correction"
> & {
  bankItemId: string;
  concept: string;
  conceptDefinition?: string;
  conceptProperties?: string[];
  misconceptionLabels?: Record<string, string>;
  misconceptionLabel?: string;
  answer?: string;
  acceptedAnswers?: string[];
  explanation?: string;
  choiceFeedback?: BankItem["choiceFeedback"];
  correction?: string;
  memory?: "known" | "unsure" | "unknown";
  result?: Result;
  response?: string;
  feedback?: string;
  misconceptionTag?: string;
  requiresSelfGrade?: boolean;
};
export type StudySession = {
  id: string;
  mode: StudyMode;
  items: StudyItem[];
  createdAt: string;
  status: "active" | "complete";
  materialIds: string[];
  originQuestionIds: string[];
  conceptIds: string[];
  label: string;
  understoodConceptIds: string[];
  feedback?: string;
  notice?: string;
};
export type AppState = {
  todaySolved?: number | null;
  materials: Material[];
  questions: Question[];
  mistakes: Mistake[];
  sessions: Pick<SolveSession, "id" | "status" | "createdAt">[];
  studies: Pick<StudySession, "id" | "status" | "createdAt" | "label" | "mode">[];
  concepts: Concept[];
  chapters?: {
    id: string;
    materialId: string;
    title: string;
    startPage: number;
    endPage: number;
  }[];
  bankStats: { conceptId: string; count: number; modes: string[] }[];
  migration?: Record<string, unknown>;
};
export type ContentMapping = {
  questionId?: string;
  materialId?: string;
  number?: number;
  page?: number;
  conceptIds: string[];
  answer?: string;
  explanation?: string;
};
export type ContentPackage = {
  schemaVersion: 1;
  concepts: Concept[];
  items: BankItem[];
  mappings: ContentMapping[];
  materials?: { id: string; title: string; hash: string }[];
};
export type Validation = {
  valid?: boolean;
  errors: string[];
  warnings: string[];
  counts?: Record<string, number>;
  imported?: unknown;
};
export type ContentData = {
  concepts: Concept[];
  items: BankItem[];
  mappings: ContentMapping[];
  materials: Material[];
  issues: Validation;
  counts: Record<string, number>;
};
