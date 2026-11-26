import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createController } from './controller.ts';
import { initialState, type LiveState } from './reducer.ts';

export const liveStore = createStore<LiveState>(() => initialState('CONNECTING'));
export const useLive = <T,>(pick: (s: LiveState) => T): T => useStore(liveStore, pick);

export const controller = createController({
  store: liveStore,
  storage: window.sessionStorage,
  url: (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws',
});
