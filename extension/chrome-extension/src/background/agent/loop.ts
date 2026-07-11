import type { PerceptionSnapshot, TaskRecord } from '@extension/storage';
import { Actors, chatSettingsStore, trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState, clearHighlights } from '../perception';
import { executeAction } from '../actions/executor';
import { streamChatReply } from './chat';
import { groundTarget } from './grounder';
import { planNextAction, validateCompletion, decisionToAction } from './planner';
import type { PlannerDecision } from './planner';
import {
  PLANNER_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  formatPlannerTurn,
  formatValidatorTurn,
} from './prompts';
import { isOrchestratorConfigured, triageTask, checkpoint, rescueSubtask } from './orchestrator';
import type { Subtask, SubtaskOutcome, CallUsage } from './orchestrator';

const logger = createLogger('agent');

const MAX_STEPS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;
// Validate at most once: a 4B validator that rejects twice is more likely
// wrong than the planner; don't burn the step budget arguing
const MAX_VALIDATION_REJECTIONS = 1;
// A decision repeated this many times (or a page unchanged across this many
// steps) means the executor is looping — warn once, then declare stuck
const STUCK_REPEAT_THRESHOLD = 3;
// Orchestrated-mode budgets
const MAX_SUBTASKS = 8;
const MAX_REPLANS = 2;
const MAX_RESCUES_PER_SUBTASK = 1;

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  return `☁ ${usage.model} · ${cost}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizable(decision: any): string {
  switch (decision.action) {
    case 'click':
      return decision.index !== undefined ? `click [${decision.index}]` : `click "${decision.target}"`;
    case 'type':
      return `type "${decision.text}" into [${decision.index}]`;
    case 'scroll':
      return `scroll ${decision.direction ?? 'down'}`;
    case 'navigate':
      return `navigate to ${decision.url}`;
    case 'back':
      return 'go back';
    default:
      return decision.action;
  }
}

function decisionKey(decision: PlannerDecision): string {
  return JSON.stringify([
    decision.action,
    decision.index,
    decision.target,
    decision.text,
    decision.url,
    decision.direction,
  ]);
}

function pageSignature(state: PerceptionSnapshot | null): string {
  if (!state) return 'no-state';
  return `${state.url}|${state.scroll.y}|${state.elements.length}|${state.elements
    .map(el => el.text)
    .join(',')
    .slice(0, 400)}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 60).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

interface SubtaskRunResult {
  status: 'ok' | 'fail' | 'stuck' | 'streamed';
  summary: string;
  actions: string[];
  url?: string;
  title?: string;
  /** Element labels at the point of getting stuck (rescue-call input) */
  elementsDigest?: string[];
}

interface SubtaskOptions {
  /** TaskRecord this subtask belongs to */
  taskRecordId: string;
  /** Success criterion (recorded; also appended to the goal by callers) */
  success?: string;
  plannedBy: 'orchestrator' | 'user';
  /** Run the local 4B validator on 'done' (local-only mode; checkpoints cover it in hybrid) */
  useLocalValidator: boolean;
  /** Allow a 'respond' decision to fall through to streaming chat (top-level tasks only) */
  allowRespondChat: boolean;
  /** Prefix for step narration, e.g. "[2/4] " */
  stepPrefix?: string;
}

/**
 * The inner loop: perceive → plan → execute against one bounded goal.
 * Detects decision loops and no-effect streaks (warn once, then 'stuck').
 * Returns a structured outcome and writes a SubtaskRecord; posts step
 * narration but no terminal events — callers decide how the task ends.
 */
async function runSubtask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  goal: string,
  opts: SubtaskOptions,
  signal: AbortSignal,
): Promise<SubtaskRunResult> {
  const subtaskId = crypto.randomUUID();
  const startedAt = Date.now();
  const history: string[] = [];
  const prefix = opts.stepPrefix ?? '';
  let consecutiveFailures = 0;
  let validationRejections = 0;
  let stepsCount = 0;
  let lastState: PerceptionSnapshot | null = null;
  // Loop detection
  let repeatKey = '';
  let repeatCount = 0;
  let lastSignature = '';
  let sameSignatureStreak = 0;
  let loopWarned = false;

  const { model: localModel, grounderModel } = await chatSettingsStore.getSettings();
  const plannerMeta = `⌂ ${localModel} (local) · $0`;
  const grounderMeta = `⌂ ${grounderModel.split('/').pop()} (local) · $0`;

  const finalize = async (status: 'ok' | 'fail' | 'stuck', summary: string): Promise<SubtaskRunResult> => {
    await trajectoryStore
      .appendSubtask({
        id: subtaskId,
        sessionId: taskId,
        taskRecordId: opts.taskRecordId,
        goal,
        success: opts.success ?? '',
        status,
        summary,
        stepsCount,
        plannedBy: opts.plannedBy,
        startedAt,
        endedAt: Date.now(),
      })
      .catch(error => logger.warning('subtask record failed:', error));
    return {
      status,
      summary,
      actions: history.slice(-6),
      url: lastState?.url,
      title: lastState?.title,
      elementsDigest: status === 'stuck' ? elementsDigestOf(lastState) : undefined,
    };
  };

  const logRejectedDecision = (decision: PlannerDecision, error: string) => {
    if (!lastState) return;
    trajectoryStore
      .appendStep({
        sessionId: taskId,
        before: lastState,
        action: null,
        ok: false,
        error,
        timestamp: Date.now(),
        subtaskId,
        decision,
        plannerModel: localModel,
        historyContext: history.slice(-8),
      })
      .catch(err => logger.warning('trajectory logging failed:', err));
  };

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      const state: PerceptionSnapshot | null = await capturePageState(tabId, true).catch(error => {
        logger.warning('perception failed:', error);
        return null;
      });
      lastState = state ?? lastState;

      // No-effect detection: the page has not changed across executed steps
      const signature = pageSignature(state);
      if (signature === lastSignature) sameSignatureStreak++;
      else {
        sameSignatureStreak = 0;
        lastSignature = signature;
      }

      const decision = await planNextAction(PLANNER_SYSTEM_PROMPT, formatPlannerTurn(goal, history, state), signal);
      logger.info(`${prefix}step ${step}:`, JSON.stringify(decision));
      stepsCount++;

      // Repeated-decision detection
      const key = decisionKey(decision);
      if (key === repeatKey) repeatCount++;
      else {
        repeatKey = key;
        repeatCount = 1;
      }
      const isTerminal = decision.action === 'done' || decision.action === 'respond';
      if (!isTerminal && (repeatCount >= STUCK_REPEAT_THRESHOLD || sameSignatureStreak >= STUCK_REPEAT_THRESHOLD)) {
        if (!loopWarned) {
          loopWarned = true;
          repeatCount = 0;
          logRejectedDecision(decision, 'suppressed: repeated action with no page change');
          history.push(
            'NOTE: you are repeating the same action and the page is NOT changing. That approach does not work. ' +
              'Choose something DIFFERENT: another element, scroll, navigate, or report the blocker via done.',
          );
          continue;
        }
        logRejectedDecision(decision, 'stuck: repeated action with no page change after warning');
        await clearHighlights(tabId).catch(() => {});
        return await finalize(
          'stuck',
          `Looping without progress: repeated "${summarizable(decision)}" with no page change. Last steps:\n${history
            .slice(-4)
            .join('\n')}`,
        );
      }

      if (decision.action === 'respond') {
        if (opts.allowRespondChat) {
          await clearHighlights(tabId).catch(() => {});
          await streamChatReply(port, taskId, goal, signal);
          return await finalize('ok', '(answered conversationally)').then(r => ({ ...r, status: 'streamed' as const }));
        }
        // Inside a plan, 'respond' means: nothing to do in the browser
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', decision.message || 'No browser action was needed for this subtask.');
      }

      if (decision.action === 'done') {
        const answer = decision.message || 'Subtask complete.';
        if (opts.useLocalValidator && validationRejections < MAX_VALIDATION_REJECTIONS && history.length > 0) {
          const verdict = await validateCompletion(
            VALIDATOR_SYSTEM_PROMPT,
            formatValidatorTurn(goal, history, answer, state),
            signal,
          ).catch(error => {
            logger.warning('validator failed, accepting answer:', error);
            return { valid: true, reason: '' };
          });
          if (!verdict.valid) {
            validationRejections++;
            history.push(`done rejected by validator: ${verdict.reason}`);
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `Validator: not done — ${verdict.reason}`,
              plannerMeta,
            );
            continue;
          }
        }
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', answer);
      }

      const logContext = {
        subtaskId,
        decision,
        plannerModel: localModel,
        historyContext: history.slice(-8),
      };

      // Hybrid grounding: click-by-target routes through the vision grounder
      if (decision.action === 'click' && decision.index === undefined && decision.target) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${prefix}Step ${step}: locating "${decision.target}" visually — ${decision.reasoning}`,
          grounderMeta,
        );
        // Highlights would pollute the grounder's screenshot
        await clearHighlights(tabId).catch(() => {});
        try {
          const point = await groundTarget(tabId, decision.target, signal);
          const result = await executeAction(
            tabId,
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
            logContext,
          );
          history.push(`ground+click "${decision.target}" -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);
          consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          history.push(`ground "${decision.target}" -> FAILED: ${message}`);
          consecutiveFailures++;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      const action = decisionToAction(decision);
      if (action === null) continue; // unreachable, satisfies types
      if ('error' in action) {
        logRejectedDecision(decision, action.error);
        history.push(`invalid decision (${summarizable(decision)}): ${action.error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      // Reject hallucinated indices before executing: the planner must pick
      // from the PAGE list it was shown
      if ((action.type === 'click' || action.type === 'type') && state && action.index >= state.elements.length) {
        const error =
          `index ${action.index} is not in the PAGE list ` +
          `(it has ${state.elements.length} elements, [0]..[${state.elements.length - 1}])`;
        logRejectedDecision(decision, error);
        history.push(`${summarizable(decision)} -> REJECTED: ${error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `${prefix}Step ${step}: ${summarizable(decision)} — ${decision.reasoning}`,
        plannerMeta,
      );

      const result = await executeAction(tabId, taskId, action, state, logContext);
      history.push(`${summarizable(decision)} -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    await clearHighlights(tabId).catch(() => {});
    return await finalize(
      'fail',
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last steps:\n${history.slice(-3).join('\n')}`
        : `Step budget (${MAX_STEPS}) exhausted without completing: ${goal}`,
    );
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    throw error;
  }
}

/** Local-only mode: the original single-level agent loop. */
async function runLocalTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  record.mode = 'local';
  const outcome = await runSubtask(
    port,
    tabId,
    taskId,
    task,
    { taskRecordId: record.id, plannedBy: 'user', useLocalValidator: true, allowRespondChat: true },
    signal,
  );
  if (outcome.status === 'streamed') {
    record.outcome = 'ok';
    return; // chat path posted its own events
  }
  const meta = `⌂ ${record.localModel} (local) · task total $0`;
  if (outcome.status === 'ok') {
    record.outcome = 'ok';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, outcome.summary, meta);
  } else {
    record.outcome = 'fail';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, outcome.summary, meta);
  }
}

/** Hybrid mode: cloud orchestrator plans, checkpoints, and rescues; local models execute. */
async function runOrchestratedTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  let costKnown = true;
  const track = (usage: CallUsage): string => {
    record.cloudCalls++;
    record.orchestratorModel = usage.model;
    if (usage.cost !== null) record.totalCostUsd += usage.cost;
    else costKnown = false;
    return cloudMeta(usage);
  };
  const totalMeta = () =>
    `task total ${costKnown ? '' : '≥'}$${record.totalCostUsd.toFixed(4)} · ${record.cloudCalls} cloud call${record.cloudCalls === 1 ? '' : 's'}`;

  const finishOk = (answer: string, meta: string) => {
    record.outcome = 'ok';
    record.answer = answer;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, answer, `${meta} · ${totalMeta()}`);
  };
  const finishFail = (reason: string, meta: string) => {
    record.outcome = 'fail';
    record.answer = reason;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, reason, `${meta} · ${totalMeta()}`);
  };

  // Run one subtask with stuck-rescue: on 'stuck', ask the orchestrator for a
  // corrected goal and retry once before reporting the outcome
  const runWithRescue = async (
    subtask: Subtask,
    stepPrefix: string,
  ): Promise<{ run: SubtaskRunResult; goal: string; replanRequest?: Subtask[] }> => {
    let currentGoal = subtask.goal;
    let currentSuccess = subtask.success;
    let rescues = 0;
    for (;;) {
      const run = await runSubtask(
        port,
        tabId,
        taskId,
        `${currentGoal} (success: ${currentSuccess})`,
        {
          taskRecordId: record.id,
          success: currentSuccess,
          plannedBy: 'orchestrator',
          useLocalValidator: false,
          allowRespondChat: false,
          stepPrefix,
        },
        signal,
      );
      if (run.status !== 'stuck' || rescues >= MAX_RESCUES_PER_SUBTASK) {
        return { run, goal: currentGoal };
      }
      rescues++;
      const { result: rescue, usage } = await rescueSubtask(
        task,
        {
          goal: currentGoal,
          actions: run.actions,
          elements: run.elementsDigest ?? [],
          url: run.url,
          title: run.title,
        },
        signal,
      );
      const rescueMeta = track(usage);
      logger.info('rescue:', JSON.stringify(rescue).slice(0, 300));
      if (rescue.decision === 'retry' && rescue.revisedGoal) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Stuck — orchestrator revised the goal: ${rescue.revisedGoal}${rescue.reason ? ` (${rescue.reason})` : ''}`,
          rescueMeta,
        );
        currentGoal = rescue.revisedGoal;
        currentSuccess = rescue.revisedSuccess || currentSuccess;
        continue;
      }
      if (rescue.decision === 'replan' && rescue.subtasks?.length) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Stuck — orchestrator wants to replan${rescue.reason ? `: ${rescue.reason}` : ''}`,
          rescueMeta,
        );
        return { run, goal: currentGoal, replanRequest: rescue.subtasks };
      }
      // rescue says fail — surface the diagnosis as the outcome summary
      return {
        run: { ...run, status: 'fail', summary: rescue.reason || run.summary },
        goal: currentGoal,
      };
    }
  };

  const { result: triage, usage: triageUsage } = await triageTask(task, signal);
  const triageMeta = track(triageUsage);
  logger.info('triage:', JSON.stringify(triage).slice(0, 300));
  record.mode = triage.mode;

  if (triage.mode === 'chat') {
    finishOk(triage.reply || '', triageMeta);
    return;
  }

  if (triage.mode === 'execute') {
    // Single concrete goal: run the local loop, checkpoint validates the result
    const { run, goal } = await runWithRescue({ goal: task, success: 'the task is complete' }, '');
    const plan: Subtask[] = [{ goal, success: 'the task is complete' }];
    const { result: verdict, usage } = await checkpoint(task, plan, [toOutcome(goal, run)], signal);
    const meta = track(usage);
    if (verdict.decision === 'done' || (verdict.decision === 'continue' && run.status === 'ok')) {
      finishOk(verdict.answer || run.summary, meta);
    } else {
      finishFail(verdict.reason || run.summary, meta);
    }
    return;
  }

  // mode === 'plan'
  let plan = (triage.subtasks ?? []).slice(0, MAX_SUBTASKS);
  const outcomes: SubtaskOutcome[] = [];
  let index = 0;

  const applyReplan = (subtasks: Subtask[], meta: string, label: string): boolean => {
    if (record.replans >= MAX_REPLANS) return false;
    record.replans++;
    plan = subtasks.slice(0, MAX_SUBTASKS);
    index = 0;
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `${label} (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
      meta,
    );
    return true;
  };

  postExecutionEvent(
    port,
    Actors.SYSTEM,
    'step.ok',
    taskId,
    `Plan (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
    triageMeta,
  );

  while (index < plan.length && outcomes.length < MAX_SUBTASKS + MAX_REPLANS * 2) {
    const subtask = plan[index];
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Subtask ${index + 1}/${plan.length}: ${subtask.goal}`);

    const { run, goal, replanRequest } = await runWithRescue(subtask, `[${index + 1}/${plan.length}] `);
    outcomes.push(toOutcome(goal, run));

    if (replanRequest) {
      if (!applyReplan(replanRequest, '', 'Replanned')) {
        finishFail('Replan budget exhausted while stuck.', '');
        return;
      }
      continue;
    }

    const { result: verdict, usage } = await checkpoint(task, plan, outcomes, signal);
    const checkpointMeta = track(usage);
    logger.info('checkpoint:', JSON.stringify(verdict).slice(0, 300));

    if (verdict.decision === 'done') {
      finishOk(verdict.answer || 'Task complete.', checkpointMeta);
      return;
    }
    if (verdict.decision === 'fail') {
      finishFail(verdict.reason || 'The orchestrator gave up.', checkpointMeta);
      return;
    }
    if (verdict.decision === 'replan') {
      if (!verdict.subtasks?.length || !applyReplan(verdict.subtasks, checkpointMeta, 'Replanned')) {
        finishFail(`Replan budget exhausted. ${verdict.reason ?? ''}`.trim(), checkpointMeta);
        return;
      }
      continue;
    }
    index++;
  }

  // Plan ran out without an explicit done — ask for a final verdict
  const { result: final, usage: finalUsage } = await checkpoint(task, plan, outcomes, signal);
  const finalMeta = track(finalUsage);
  if (final.decision === 'done') {
    finishOk(final.answer || 'Task complete.', finalMeta);
  } else {
    finishFail(final.reason || 'Plan completed without a confirmed result.', finalMeta);
  }
}

function toOutcome(goal: string, run: SubtaskRunResult): SubtaskOutcome {
  return {
    goal,
    status: run.status === 'ok' ? 'ok' : 'fail',
    summary: run.summary,
    actions: run.actions,
    url: run.url,
    title: run.title,
  };
}

/**
 * Task entry point. Hybrid (orchestrated) when a cloud orchestrator is
 * configured; otherwise the original local-only loop. Always writes a
 * TaskRecord (the end-to-end training label).
 */
export async function runAgentTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);
  const settings = await chatSettingsStore.getSettings();
  const record: TaskRecord = {
    id: crypto.randomUUID(),
    sessionId: taskId,
    task,
    mode: 'local',
    outcome: 'fail',
    answer: '',
    replans: 0,
    totalCostUsd: 0,
    cloudCalls: 0,
    localModel: settings.model,
    grounderModel: settings.grounderModel,
    startedAt: Date.now(),
    endedAt: 0,
  };
  try {
    if (await isOrchestratorConfigured()) {
      await runOrchestratedTask(port, tabId, taskId, task, record, signal);
    } else {
      await runLocalTask(port, tabId, taskId, task, record, signal);
    }
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    if (signal.aborted) {
      record.outcome = 'cancel';
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      record.outcome = 'fail';
      record.answer = message;
      logger.error('agent task failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  } finally {
    record.endedAt = Date.now();
    trajectoryStore.appendTask(record).catch(error => logger.warning('task record failed:', error));
  }
}
