import { TaskManager } from '../state/task-manager.js';
import type { TaskNodeDefinition, TaskGraph, TaskGraphConfig, DAGResult, DAGNodeResult, RunWorkerFn } from './types.js';

export class DAGEngine {
  private taskManager: TaskManager;
  private runWorker: RunWorkerFn;

  constructor(taskManager: TaskManager, runWorker: RunWorkerFn) {
    this.taskManager = taskManager;
    this.runWorker = runWorker;
  }

  async execute(graph: TaskGraph): Promise<DAGResult> {
    // STEP 1: Validate graph
    this.validateGraph(graph);

    // STEP 2: Create task in state manager
    const taskId = this.taskManager.createTask(graph, graph.config);
    const startTime = Date.now();

    // STEP 3: Create all nodes in state manager
    for (const def of graph.nodes) {
      this.taskManager.createNode(taskId, {
        id: def.id,
        agent: def.agent,
        prompt: def.prompt,
        depends_on: JSON.stringify(def.dependsOn),
      });
    }

    // Mark task as running
    this.taskManager.updateTaskStatus(taskId, 'running');

    // STEP 4: Build dependency graph
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    const nodeMap = new Map<string, TaskNodeDefinition>();

    for (const node of graph.nodes) {
      nodeMap.set(node.id, node);
      inDegree.set(node.id, node.dependsOn.length);
      if (!adjacency.has(node.id)) adjacency.set(node.id, []);
      for (const dep of node.dependsOn) {
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(node.id);
      }
    }

    // STEP 5: Kahn's algorithm — execution loop
    const results = new Map<string, DAGNodeResult>();
    const queue: string[] = [];
    const maxConcurrent = graph.config.maxConcurrent ?? 3;

    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let aborted = false;

    while (queue.length > 0 && !aborted) {
      // Take batch respecting maxConcurrent
      const batch = queue.splice(0, maxConcurrent);

      // Execute batch in parallel
      const batchResults = await Promise.all(
        batch.map(nodeId => this.executeNode(nodeId, nodeMap, results, graph.config))
      );

      for (const result of batchResults) {
        results.set(result.nodeId, result);

        // Handle failure
        if (result.status === 'failed') {
          const def = nodeMap.get(result.nodeId);
          if (def?.critical !== false) {
            aborted = true;
          }
        }

        // Decrement in-degree of dependents
        const dependents = adjacency.get(result.nodeId) || [];
        for (const depId of dependents) {
          const currentDegree = inDegree.get(depId)! - 1;
          inDegree.set(depId, currentDegree);
          if (currentDegree === 0) {
            queue.push(depId);
          }
        }
      }
    }

    // STEP 6: Determine overall status
    const nodeResults = Array.from(results.values());
    const allCompleted = nodeResults.every(r => r.status === 'completed');
    const anyFailed = nodeResults.some(r => r.status === 'failed');
    let status: 'completed' | 'failed' | 'partial';
    if (allCompleted) status = 'completed';
    else if (anyFailed && aborted) status = 'failed';
    else status = 'partial';

    // Calculate totals
    const totalCost = nodeResults.reduce((sum, r) => sum + r.cost, 0);
    const totalDurationMs = Date.now() - startTime;

    // Update task in state manager
    this.taskManager.setTaskCost(taskId, totalCost);
    if (status === 'completed') {
      this.taskManager.completeTask(taskId);
    } else {
      this.taskManager.updateTaskStatus(taskId, status);
    }

    return { taskId, status, nodes: nodeResults, totalCost, totalDurationMs };
  }

  private validateGraph(graph: TaskGraph): void {
    const nodeIds = new Set(graph.nodes.map(n => n.id));

    // Check for duplicate IDs
    if (nodeIds.size !== graph.nodes.length) {
      throw new Error('DAG validation failed: duplicate node IDs');
    }

    // Check that all dependsOn references exist
    for (const node of graph.nodes) {
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) {
          throw new Error(`DAG validation failed: node "${node.id}" depends on non-existent node "${dep}"`);
        }
      }
    }

    // Check for circular dependencies using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function hasCycle(nodeId: string, _adjacency: Map<string, string[]>): boolean {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      for (const dep of graph.nodes.find(n => n.id === nodeId)?.dependsOn || []) {
        if (!visited.has(dep)) {
          if (hasCycle(dep, _adjacency)) return true;
        } else if (recursionStack.has(dep)) {
          return true; // cycle found
        }
      }

      recursionStack.delete(nodeId);
      return false;
    }

    const adjacency = new Map<string, string[]>();
    for (const node of graph.nodes) {
      adjacency.set(node.id, node.dependsOn);
    }

    for (const nodeId of nodeIds) {
      if (!visited.has(nodeId)) {
        if (hasCycle(nodeId, adjacency)) {
          throw new Error('DAG validation failed: circular dependency detected');
        }
      }
    }
  }

  private async executeNode(
    nodeId: string,
    nodeMap: Map<string, TaskNodeDefinition>,
    results: Map<string, DAGNodeResult>,
    config: TaskGraphConfig
  ): Promise<DAGNodeResult> {
    const def = nodeMap.get(nodeId)!;
    const maxRetries = def.retry ?? 2;
    const timeout = def.timeout ?? config.defaultTimeout ?? 300_000;
    const startedAt = Date.now();

    // Resolve prompt templates
    const resolvedPrompt = resolvePromptTemplates(def.prompt, results);

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Exponential backoff: 0s, 5s, 10s, 20s...
        if (attempt > 0) {
          const delay = 5000 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
        }

        const workerResult = await this.runWorker({
          agent: def.agent,
          prompt: resolvedPrompt,
          timeout,
        });

        return {
          nodeId,
          status: 'completed',
          result: workerResult.text,
          sessionId: workerResult.sessionId,
          cost: workerResult.cost,
          tokensIn: workerResult.tokensIn,
          tokensOut: workerResult.tokensOut,
          durationMs: Date.now() - startedAt,
          retries: attempt,
          startedAt,
          completedAt: Date.now(),
        };
      } catch (error: unknown) {
        const err = error as Error;
        lastError = err?.message || String(error);

        // Check if this is a context-limit error and we have a fallback
        if (isContextLimitError(err) && def.fallbackAgent && attempt === maxRetries) {
          def.agent = def.fallbackAgent;
          continue; // retry with fallback agent (don't count as extra retry)
        }

        // If we have retries left, continue the loop
        if (attempt < maxRetries) continue;
      }
    }

    return {
      nodeId,
      status: 'failed',
      error: lastError || 'Unknown error',
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - startedAt,
      retries: maxRetries,
      startedAt,
      completedAt: Date.now(),
    };
  }
}

// ---- Helper functions ----

function resolvePromptTemplates(
  template: string,
  results: Map<string, DAGNodeResult>
): string {
  return template.replace(/\{\{(\w[\w-]*)\.(\w+)\}\}/g, (match, nodeId, field) => {
    const nodeResult = results.get(nodeId);
    if (!nodeResult) return match;

    switch (field) {
      case 'result': return nodeResult.result || match;
      case 'error': return nodeResult.error || match;
      case 'summary': return (nodeResult.result || '').slice(0, 500);
      default: return match;
    }
  });
}

function isContextLimitError(error: unknown): boolean {
  const msg = (error as Error)?.message?.toLowerCase() || '';
  return msg.includes('context') || msg.includes('token') || msg.includes('length');
}
