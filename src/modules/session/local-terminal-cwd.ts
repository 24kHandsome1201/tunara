export const DEFAULT_LOCAL_TERMINAL_DIR = "~";

interface SessionDirSource {
  dir: string;
  remote?: unknown;
}

interface SessionRemoteSource {
  remote?: unknown;
}

export function canUseSessionDirForLocalTerminal(session: SessionRemoteSource | null | undefined): boolean {
  return !!session && !session.remote;
}

export function localTerminalCwdFromSession(session: SessionDirSource | null | undefined): string {
  if (!session || !canUseSessionDirForLocalTerminal(session)) return DEFAULT_LOCAL_TERMINAL_DIR;
  return session.dir;
}
