import type { Actors } from '@extension/storage';

export enum EventType {
  /**
   * Type of events that can be subscribed to.
   *
   * For now, only execution events are supported.
   */
  EXECUTION = 'execution',
}

export enum ExecutionState {
  /**
   * States representing different phases in the execution lifecycle.
   *
   * Format: <SCOPE>.<STATUS>
   */
  TASK_START = 'task.start',
  TASK_OK = 'task.ok',
  TASK_FAIL = 'task.fail',
  TASK_CANCEL = 'task.cancel',

  // Agent-loop step progress
  STEP_OK = 'step.ok',
}

export interface EventData {
  /** Data associated with an event */
  taskId: string;
  /** step is the step number of the task where the event occurred */
  step: number;
  /** max_steps is the maximum number of steps in the task */
  maxSteps: number;
  /** details is the content of the event */
  details: string;
  /** attribution line: which model produced this and what it cost */
  meta?: string;
}

export interface AgentEvent {
  /**
   * Represents a state change event in the task execution system.
   */
  actor: Actors;
  state: ExecutionState;
  data: EventData;
  timestamp: number;
  type: EventType;
}
