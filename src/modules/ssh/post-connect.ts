import type { RemoteInfo, Session } from "@/ui/types";
import { normalizePostConnectCommand } from "./hosts-model";

/** Pending-input fields that type the host's post-connect command once the PTY is ready. */
export function postConnectPendingInput(remote: RemoteInfo | undefined): Pick<Session, "pendingInput" | "pendingInputSubmit"> {
  const command = normalizePostConnectCommand(remote?.postConnectCommand);
  return command
    ? { pendingInput: command, pendingInputSubmit: true }
    : { pendingInput: undefined, pendingInputSubmit: undefined };
}
