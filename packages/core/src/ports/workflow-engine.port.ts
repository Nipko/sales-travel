export interface WorkflowStartOptions {
  workflowId: string;
  taskQueue: string;
  args?: unknown[];
}

export interface WorkflowEnginePort {
  start<T>(workflowName: string, options: WorkflowStartOptions): Promise<{ runId: string }>;
  signal(workflowId: string, signalName: string, payload?: unknown): Promise<void>;
  query<T>(workflowId: string, queryName: string): Promise<T>;
}
