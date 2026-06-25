export interface UnreadCountable {
  unread?: boolean;
}

export function countUnread(sessions: readonly UnreadCountable[]): number {
  return sessions.reduce((n, s) => (s.unread ? n + 1 : n), 0);
}
