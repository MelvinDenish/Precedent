import { create } from 'zustand';
import type { Toast, ToastTone } from '../types';

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'tone' | 'duration'> & { tone?: ToastTone; duration?: number }) => string;
  dismiss: (id: string) => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: ({ tone = 'neutral', duration = 4500, ...rest }) => {
    const id = `toast-${++seq}`;
    set((s) => ({ toasts: [...s.toasts, { id, tone, duration, ...rest }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (title: string, body?: string) => useToastStore.getState().push({ title, body }),
  success: (title: string, body?: string) =>
    useToastStore.getState().push({ title, body, tone: 'positive' }),
  error: (title: string, body?: string) =>
    useToastStore.getState().push({ title, body, tone: 'danger', duration: 8000 }),
};
