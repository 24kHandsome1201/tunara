type Writer = (data: string) => void;

const writers = new Map<string, Writer>();

export function registerBroadcastWriter(sessionId: string, write: Writer): () => void {
  writers.set(sessionId, write);
  return () => {
    if (writers.get(sessionId) === write) writers.delete(sessionId);
  };
}

export function broadcastTerminalInput(sourceSessionId: string, data: string, targetSessionIds: readonly string[]): number {
  if (!data) return 0;
  let sent = 0;
  for (const sessionId of targetSessionIds) {
    if (sessionId === sourceSessionId) continue;
    const write = writers.get(sessionId);
    if (!write) continue;
    write(data);
    sent += 1;
  }
  return sent;
}

export function broadcastWriterCount(): number {
  return writers.size;
}

export function resetBroadcastWritersForTests(): void {
  writers.clear();
}
