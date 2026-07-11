export const DEFAULT_LOCAL_TERMINAL_DIR = "~";

interface SessionDirSource<Remote = unknown> {
  dir: string;
  remote?: Remote;
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

export function splitTerminalContextFromSession<Remote>(
  session: SessionDirSource<Remote> | null | undefined,
): { dir: string; remote?: Remote } {
  if (!session) return { dir: DEFAULT_LOCAL_TERMINAL_DIR };
  return {
    dir: session.dir,
    ...(session.remote ? { remote: { ...session.remote } } : {}),
  };
}
