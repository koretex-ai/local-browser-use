import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { SubtaskRecord, TaskRecord, TrajectoryStep, TrajectoryStorage } from './types';

// Index of session ids that have trajectory data
const trajectorySessionsStorage = createStorage<string[]>('trajectory_sessions', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

// Records are stored per session to keep individual entries small
const getSessionStepsStorage = (sessionId: string) =>
  createStorage<TrajectoryStep[]>(`trajectory_steps_${sessionId}`, [], {
    storageEnum: StorageEnum.Local,
    liveUpdate: false,
  });

const getSessionSubtasksStorage = (sessionId: string) =>
  createStorage<SubtaskRecord[]>(`trajectory_subtasks_${sessionId}`, [], {
    storageEnum: StorageEnum.Local,
    liveUpdate: false,
  });

const getSessionTasksStorage = (sessionId: string) =>
  createStorage<TaskRecord[]>(`trajectory_tasks_${sessionId}`, [], {
    storageEnum: StorageEnum.Local,
    liveUpdate: false,
  });

async function registerSession(sessionId: string): Promise<void> {
  await trajectorySessionsStorage.set(prev => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
}

export const trajectoryStore: TrajectoryStorage = {
  appendStep: async step => {
    const newStep: TrajectoryStep = { ...step, id: crypto.randomUUID() };
    await registerSession(step.sessionId);
    await getSessionStepsStorage(step.sessionId).set(prev => [...prev, newStep]);
    return newStep;
  },

  appendSubtask: async record => {
    await registerSession(record.sessionId);
    await getSessionSubtasksStorage(record.sessionId).set(prev => [...prev, record]);
  },

  appendTask: async record => {
    await registerSession(record.sessionId);
    await getSessionTasksStorage(record.sessionId).set(prev => [...prev, record]);
  },

  getSteps: async sessionId => getSessionStepsStorage(sessionId).get(),
  getSubtasks: async sessionId => getSessionSubtasksStorage(sessionId).get(),
  getTasks: async sessionId => getSessionTasksStorage(sessionId).get(),

  getSessionIds: async () => trajectorySessionsStorage.get(),

  clearSession: async sessionId => {
    await getSessionStepsStorage(sessionId).set([]);
    await getSessionSubtasksStorage(sessionId).set([]);
    await getSessionTasksStorage(sessionId).set([]);
    await trajectorySessionsStorage.set(prev => prev.filter(id => id !== sessionId));
  },

  clearAll: async () => {
    const sessionIds = await trajectorySessionsStorage.get();
    for (const sessionId of sessionIds) {
      await getSessionStepsStorage(sessionId).set([]);
      await getSessionSubtasksStorage(sessionId).set([]);
      await getSessionTasksStorage(sessionId).set([]);
    }
    await trajectorySessionsStorage.set([]);
  },
};
