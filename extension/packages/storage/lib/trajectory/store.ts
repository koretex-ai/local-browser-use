import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { TrajectoryStep, TrajectoryStorage } from './types';

// Index of session ids that have trajectory data
const trajectorySessionsStorage = createStorage<string[]>('trajectory_sessions', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

// Steps are stored per session to keep individual records small
const getSessionStepsStorage = (sessionId: string) =>
  createStorage<TrajectoryStep[]>(`trajectory_steps_${sessionId}`, [], {
    storageEnum: StorageEnum.Local,
    liveUpdate: false,
  });

export const trajectoryStore: TrajectoryStorage = {
  appendStep: async step => {
    const newStep: TrajectoryStep = { ...step, id: crypto.randomUUID() };

    await trajectorySessionsStorage.set(prev => (prev.includes(step.sessionId) ? prev : [...prev, step.sessionId]));

    const stepsStorage = getSessionStepsStorage(step.sessionId);
    await stepsStorage.set(prev => [...prev, newStep]);

    return newStep;
  },

  getSteps: async sessionId => {
    return getSessionStepsStorage(sessionId).get();
  },

  getSessionIds: async () => {
    return trajectorySessionsStorage.get();
  },

  clearSession: async sessionId => {
    await getSessionStepsStorage(sessionId).set([]);
    await trajectorySessionsStorage.set(prev => prev.filter(id => id !== sessionId));
  },

  clearAll: async () => {
    const sessionIds = await trajectorySessionsStorage.get();
    for (const sessionId of sessionIds) {
      await getSessionStepsStorage(sessionId).set([]);
    }
    await trajectorySessionsStorage.set([]);
  },
};
