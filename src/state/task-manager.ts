import { StateDatabase } from './schema.js';
import type { TaskRow, TaskNodeRow, AgentStatRow } from './schema.js';

export class TaskManager {
  private db: StateDatabase;

  constructor(db: StateDatabase) {
    this.db = db;
  }

  // ---- Tasks ----

  createTask(graph: object, config: object): string {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.raw.prepare(
      `INSERT INTO tasks (id, status, graph, config) VALUES (?, 'pending', ?, ?)`
    ).run(id, JSON.stringify(graph), JSON.stringify(config));
    return id;
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
  }

  updateTaskStatus(taskId: string, status: string): void {
    this.db.raw.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  }

  completeTask(taskId: string): void {
    this.db.raw.prepare(
      'UPDATE tasks SET status = ?, completed_at = unixepoch() WHERE id = ?'
    ).run('completed', taskId);
  }

  deleteTask(taskId: string): void {
    this.db.raw.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  getIncompleteTasks(): TaskRow[] {
    return this.db.raw.prepare(
      "SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at DESC"
    ).all() as TaskRow[];
  }

  // ---- Nodes ----

  createNode(taskId: string, node: Partial<TaskNodeRow> & { id: string; agent: string; prompt: string }): void {
    this.db.raw.prepare(`
      INSERT INTO task_nodes (id, task_id, agent, status, prompt, depends_on)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(
      node.id, taskId, node.agent, node.prompt,
      JSON.stringify(node.depends_on || [])
    );
  }

  getNode(nodeId: string): TaskNodeRow | undefined {
    return this.db.raw.prepare('SELECT * FROM task_nodes WHERE id = ?').get(nodeId) as TaskNodeRow | undefined;
  }

  getNodesByTask(taskId: string): TaskNodeRow[] {
    return this.db.raw.prepare('SELECT * FROM task_nodes WHERE task_id = ? ORDER BY id').all(taskId) as TaskNodeRow[];
  }

  updateNodeStatus(
    nodeId: string,
    status: string,
    result?: string | null,
    error?: string | null
  ): void {
    const updates: Record<string, unknown> = { status };
    if (result !== undefined) updates.result = result;
    if (error !== undefined) updates.error = error;
    if (status === 'completed' || status === 'failed') {
      updates.completed_at = Math.floor(Date.now() / 1000);
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), nodeId];

    this.db.raw.prepare(`UPDATE task_nodes SET ${setClauses} WHERE id = ?`).run(...values);
  }

  startNode(nodeId: string, sessionId: string): void {
    this.db.raw.prepare(
      'UPDATE task_nodes SET status = ?, session_id = ?, started_at = unixepoch() WHERE id = ?'
    ).run('running', sessionId, nodeId);
  }

  getTaskProgress(taskId: string): { total: number; completed: number; running: number; failed: number; pending: number } {
    const rows = this.db.raw.prepare(
      'SELECT status, COUNT(*) as count FROM task_nodes WHERE task_id = ? GROUP BY status'
    ).all(taskId) as { status: string; count: number }[];

    const progress = { total: 0, completed: 0, running: 0, failed: 0, pending: 0 };
    for (const row of rows) {
      progress.total += row.count;
      if (row.status === 'completed') progress.completed = row.count;
      else if (row.status === 'running') progress.running = row.count;
      else if (row.status === 'failed') progress.failed = row.count;
      else if (row.status === 'pending') progress.pending = row.count;
    }
    return progress;
  }

  resumeTask(taskId: string): { task: TaskRow; pendingNodes: TaskNodeRow[] } | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const pendingNodes = this.db.raw.prepare(
      "SELECT * FROM task_nodes WHERE task_id = ? AND status IN ('pending', 'running')"
    ).all(taskId) as TaskNodeRow[];
    return { task, pendingNodes };
  }

  // ---- Session Logging ----

  logSession(data: {
    taskId?: string;
    nodeId?: string;
    sessionId?: string;
    agent?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    cost?: number;
    durationMs?: number;
  }): void {
    this.db.raw.prepare(`
      INSERT INTO session_log (task_id, node_id, session_id, agent, model, tokens_in, tokens_out, cost, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.taskId || null, data.nodeId || null, data.sessionId || null,
      data.agent || null, data.model || null,
      data.tokensIn || 0, data.tokensOut || 0, data.cost || 0, data.durationMs || 0
    );

    // Upsert agent_stats
    if (data.agent) {
      this.db.raw.prepare(`
        INSERT INTO agent_stats (agent, total_runs, total_cost, avg_duration_ms, last_used)
        VALUES (?, 1, ?, ?, unixepoch())
        ON CONFLICT(agent) DO UPDATE SET
          total_runs = total_runs + 1,
          total_cost = total_cost + ?,
          avg_duration_ms = (avg_duration_ms * total_runs + ?) / (total_runs + 1),
          last_used = unixepoch()
      `).run(
        data.agent,
        data.cost || 0, data.durationMs || 0,
        data.cost || 0, data.durationMs || 0
      );
    }
  }

  // ---- Stats ----

  getAgentStats(): AgentStatRow[] {
    return this.db.raw.prepare('SELECT * FROM agent_stats ORDER BY total_runs DESC').all() as AgentStatRow[];
  }

  setTaskCost(taskId: string, cost: number): void {
    this.db.raw.prepare('UPDATE tasks SET total_cost = ? WHERE id = ?').run(cost, taskId);
  }
}
