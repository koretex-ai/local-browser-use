/**
 * Typed action space.
 *
 * IMPORTANT: this union doubles as the training-label schema for the data
 * flywheel — every executed action is logged verbatim as a trajectory step.
 * Change it deliberately and keep it serializable.
 */
export type Action =
  | { type: 'click'; index: number }
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
  action: Action;
  /** Whether execution reported success */
  ok: boolean;
  /** Error message if execution failed */
  error?: string;
  timestamp: number;
}

export interface TrajectoryStorage {
  appendStep: (step: Omit<TrajectoryStep, 'id'>) => Promise<TrajectoryStep>;
  getSteps: (sessionId: string) => Promise<TrajectoryStep[]>;
  getSessionIds: () => Promise<string[]>;
  clearSession: (sessionId: string) => Promise<void>;
  clearAll: () => Promise<void>;
}
