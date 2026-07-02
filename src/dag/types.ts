export interface TaskNodeDefinition {
  id: string;
  agent: string;
  prompt: string;            // supports {{node_id.result}} templates
  dependsOn: string[];       // node IDs this depends on
  retry?: number;            // max retries (default: 2)
  fallbackAgent?: string;    // if retries exhausted on context-limit
  timeout?: number;          // ms (default: 300000 = 5 min)
  critical?: boolean;        // if true, failure aborts entire graph (default: true)
}

export interface TaskGraphConfig {
  maxConcurrent: number;     // default 3
  maxCost: number;           // default Infinity
  defaultTimeout: number;    // default 300000
}

export interface TaskGraph {
  id: string;
  nodes: TaskNodeDefinition[];
  config: TaskGraphConfig;
}

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface DAGNodeResult {
  nodeId: string;
  status: NodeStatus;
  result?: string;
  error?: string;
  sessionId?: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  retries: number;
  startedAt: number;
  completedAt: number;
}

export interface DAGResult {
  taskId: string;
  status: 'completed' | 'failed' | 'partial';
  nodes: DAGNodeResult[];
  totalCost: number;
  totalDurationMs: number;
}

// Worker function signature — provided by orchestrator
export type RunWorkerFn = (config: {
  agent: string;
  prompt: string;
  timeout?: number;
}) => Promise<{
  text: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  durationMs: number;
}>;
