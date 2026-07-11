/**
 * Typed action space.
 *
 * IMPORTANT: this union doubles as the training-label schema for the data
 * flywheel — every executed action is logged verbatim as a trajectory step.
 * Change it deliberately and keep it serializable.
 */
export type Action =
  | { type: 'click'; index: number }
  // Pixel click in viewport CSS coordinates, produced by the vision grounder.
  // `target` is the natural-language instruction the grounder localized —
  // (screenshot, target, x, y) tuples are grounder training data.
  | { type: 'click_at'; x: number; y: number; target?: string }
  | { type: 'type'; index: number; text: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'done'; message: string };

// One interactive element from the set-of-marks DOM extraction
export interface InteractiveElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  placeholder: string;
  value: string;
  href: string;
  // Viewport coordinates in CSS pixels
  rect: { x: number; y: number; width: number; height: number };
}

// Hybrid perception snapshot: DOM (set-of-marks) + pixels, captured together
// so every logged step carries the vision-superset training data.
export interface PerceptionSnapshot {
  url: string;
  title: string;
  scroll: { x: number; y: number; pageHeight: number; viewportHeight: number };
  elements: InteractiveElement[];
  /** Downscaled JPEG data URL of the visible viewport */
  screenshot: string;
  capturedAt: number;
}

export interface TrajectoryStep {
  id: string;
  sessionId: string;
  /** Perception before the action was executed */
  before: PerceptionSnapshot;
  /** The executed typed action; null when the decision was rejected before execution */
  action: Action | null;
  /** Whether execution reported success */
  ok: boolean;
  /** Error message if execution failed (or why the decision was rejected) */
  error?: string;
  timestamp: number;
  // --- training-label context (v2) ---
  /** Subtask this step belongs to (joins to SubtaskRecord for outcome labels) */
  subtaskId?: string;
  /** The planner's raw decision JSON, including its reasoning */
  decision?: unknown;
  /** Model that produced the decision */
  plannerModel?: string;
  /** The HISTORY lines the planner saw when deciding (its input context) */
  historyContext?: string[];
}

// One bounded goal executed by the local loop — the credit-assignment unit
export interface SubtaskRecord {
  id: string;
  sessionId: string;
  /** TaskRecord this subtask belongs to */
  taskRecordId: string;
  goal: string;
  /** Success criterion the checkpoint judged against (empty for local mode) */
  success: string;
  status: 'ok' | 'fail' | 'stuck';
  summary: string;
  stepsCount: number;
  /** Who authored this goal */
  plannedBy: 'orchestrator' | 'user';
  startedAt: number;
  endedAt: number;
}

// One full user task — the end-to-end success label
export interface TaskRecord {
  id: string;
  sessionId: string;
  task: string;
  mode: 'local' | 'chat' | 'execute' | 'plan';
  outcome: 'ok' | 'fail' | 'cancel';
  answer: string;
  replans: number;
  totalCostUsd: number;
  cloudCalls: number;
  orchestratorModel?: string;
  localModel: string;
  grounderModel: string;
  startedAt: number;
  endedAt: number;
}

export interface TrajectoryStorage {
  appendStep: (step: Omit<TrajectoryStep, 'id'>) => Promise<TrajectoryStep>;
  appendSubtask: (record: SubtaskRecord) => Promise<void>;
  appendTask: (record: TaskRecord) => Promise<void>;
  getSteps: (sessionId: string) => Promise<TrajectoryStep[]>;
  getSubtasks: (sessionId: string) => Promise<SubtaskRecord[]>;
  getTasks: (sessionId: string) => Promise<TaskRecord[]>;
  getSessionIds: () => Promise<string[]>;
  clearSession: (sessionId: string) => Promise<void>;
  clearAll: () => Promise<void>;
}
