import { create } from "zustand";
import { type Workflow, makeWorkflowId } from "@/modules/workflows/template";

// Local, named command templates surfaced in the command palette. Persisted via
// the workspace snapshot (see persist.ts / useInit), same as recentCommands —
// no backend, no new dependency.

interface WorkflowsState {
  workflows: Workflow[];
  setWorkflows: (workflows: Workflow[]) => void;
  upsertWorkflow: (w: Omit<Workflow, "id"> & { id?: string }) => void;
  removeWorkflow: (id: string) => void;
}

export const useWorkflowsStore = create<WorkflowsState>()((set) => ({
  workflows: [],
  setWorkflows: (workflows) => set({ workflows }),
  upsertWorkflow: (w) =>
    set((state) => {
      const id = w.id ?? makeWorkflowId();
      const next: Workflow = {
        id,
        name: w.name.trim(),
        template: w.template,
        ...(w.description?.trim() ? { description: w.description.trim() } : {}),
      };
      const idx = state.workflows.findIndex((x) => x.id === id);
      if (idx === -1) return { workflows: [...state.workflows, next] };
      const workflows = state.workflows.slice();
      workflows[idx] = next;
      return { workflows };
    }),
  removeWorkflow: (id) =>
    set((state) => ({ workflows: state.workflows.filter((w) => w.id !== id) })),
}));
