export interface DirectoryPickerSession {
  dir: string;
  remote?: unknown;
}

export type DirectorySelectionResult = "created" | "cancelled" | "failed";

interface DirectoryTerminalControllerDependencies {
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  createTerminal: (directory: string) => void;
  onFailure: (error: unknown) => void;
}

/**
 * Native local pickers must never receive an SSH display path (user@host) or
 * a shell shorthand such as `~` as their default filesystem location.
 */
export function directoryPickerDefaultPath(
  session: DirectoryPickerSession | null | undefined,
): string | undefined {
  if (!session || session.remote) return undefined;
  const absolute = session.dir.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(session.dir)
    || session.dir.startsWith("\\\\");
  if (!absolute) return undefined;
  return session.dir;
}

/**
 * Coordinates the native directory picker. A single shared controller keeps
 * rapid clicks from opening stacked system dialogs while still letting every
 * UI entry point reuse exactly the same behavior.
 */
export function createDirectoryTerminalController({
  pickDirectory,
  createTerminal,
  onFailure,
}: DirectoryTerminalControllerDependencies) {
  let pending: Promise<DirectorySelectionResult> | null = null;

  const chooseOnce = async (defaultPath?: string): Promise<DirectorySelectionResult> => {
    try {
      const directory = await pickDirectory(defaultPath);
      if (directory === null) return "cancelled";
      createTerminal(directory);
      return "created";
    } catch (error) {
      onFailure(error);
      return "failed";
    }
  };

  return {
    choose(defaultPath?: string): Promise<DirectorySelectionResult> {
      if (pending) return pending;
      const task = chooseOnce(defaultPath);
      pending = task;
      void task.finally(() => {
        if (pending === task) pending = null;
      });
      return task;
    },
  };
}
