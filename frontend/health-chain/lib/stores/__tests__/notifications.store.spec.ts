import { describe, it, expect, beforeEach } from "vitest";
import { useNotificationsStore } from "../notifications.store";
import type { ServerNotificationEvent } from "../../realtime/socket";

const mockEvent = (overrides?: Partial<ServerNotificationEvent>): ServerNotificationEvent => ({
  id: "evt-1",
  type: "notification",
  severity: "info",
  title: "Test",
  message: "Test message",
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("notifications store", () => {
  beforeEach(() => {
    useNotificationsStore.setState({ notifications: [], unreadCount: 0 });
  });

  it("adds a notification as unread", () => {
    useNotificationsStore.getState().addNotification(mockEvent());
    const { notifications, unreadCount } = useNotificationsStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].read).toBe(false);
    expect(unreadCount).toBe(1);
  });

  it("marks a single notification as read", () => {
    useNotificationsStore.getState().addNotification(mockEvent({ id: "n1" }));
    useNotificationsStore.getState().markRead("n1");
    const { notifications, unreadCount } = useNotificationsStore.getState();
    expect(notifications[0].read).toBe(true);
    expect(unreadCount).toBe(0);
  });

  it("marks all notifications as read", () => {
    useNotificationsStore.getState().addNotification(mockEvent({ id: "a" }));
    useNotificationsStore.getState().addNotification(mockEvent({ id: "b" }));
    useNotificationsStore.getState().markAllRead();
    const { notifications, unreadCount } = useNotificationsStore.getState();
    expect(notifications.every((n) => n.read)).toBe(true);
    expect(unreadCount).toBe(0);
  });

  it("dismisses a notification", () => {
    useNotificationsStore.getState().addNotification(mockEvent({ id: "del" }));
    useNotificationsStore.getState().dismiss("del");
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });

  it("caps notifications at 100", () => {
    for (let i = 0; i < 105; i++) {
      useNotificationsStore.getState().addNotification(mockEvent({ id: `n${i}` }));
    }
    expect(useNotificationsStore.getState().notifications).toHaveLength(100);
  });
});
