import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ServerNotificationEvent, NotificationSeverity } from "../realtime/socket";

export interface Notification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  meta?: Record<string, unknown>;
}

interface NotificationsState {
  notifications: Notification[];
  unreadCount: number;
}

interface NotificationsActions {
  addNotification: (event: ServerNotificationEvent) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
}

type NotificationsStore = NotificationsState & NotificationsActions;

export const useNotificationsStore = create<NotificationsStore>()(
  persist(
    (set) => ({
      notifications: [],
      unreadCount: 0,

      addNotification: (event) =>
        set((state) => {
          const notification: Notification = { ...event, read: false };
          const notifications = [notification, ...state.notifications].slice(0, 100);
          return { notifications, unreadCount: notifications.filter((n) => !n.read).length };
        }),

      markRead: (id) =>
        set((state) => {
          const notifications = state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          );
          return { notifications, unreadCount: notifications.filter((n) => !n.read).length };
        }),

      markAllRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
          unreadCount: 0,
        })),

      dismiss: (id) =>
        set((state) => {
          const notifications = state.notifications.filter((n) => n.id !== id);
          return { notifications, unreadCount: notifications.filter((n) => !n.read).length };
        }),
    }),
    {
      name: "notifications-storage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        notifications: state.notifications,
        unreadCount: state.unreadCount,
      }),
    }
  )
);
