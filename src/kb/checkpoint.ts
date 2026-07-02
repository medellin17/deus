import { TaskManager } from '../state/task-manager.js';
import type { TaskRow } from '../state/schema.js';
import { MemoryTree } from './memory-tree.js';

export class CheckpointManager {
  private taskManager: TaskManager;
  private memoryTree: MemoryTree;

  constructor(taskManager: TaskManager, memoryTree: MemoryTree) {
    this.taskManager = taskManager;
    this.memoryTree = memoryTree;
  }

  /**
   * Сохраняет чекпоинт: записывает summary в kb_memory_tree.
   * Если GEMINI_API_KEY установлен — генерирует расширенное саммари через LLM.
   * @param taskId — ID задачи из таблицы tasks
   * @param summary — текст саммари
   * @returns taskId (он же checkpointId)
   */
  async save(taskId: string, summary: string): Promise<string> {
    // Сохраняем raw summary сразу (всегда работает)
    this.memoryTree.upsert(`checkpoint:${taskId}`, 'checkpoint', summary);

    // Опционально — улучшаем саммари через LLM
    if (process.env.GEMINI_API_KEY) {
      try {
        const { summary: llmSummary } = await this.memoryTree.generateSummary(
          `checkpoint:${taskId}`,
          summary
        );
        this.memoryTree.upsert(`checkpoint:${taskId}`, 'checkpoint', llmSummary);
      } catch {
        // fallback — оставляем raw summary
      }
    }

    return taskId;
  }

  /**
   * Загружает чекпоинт по taskId.
   * @returns { task, summary } или null, если задача не найдена
   */
  load(taskId: string): { task: TaskRow; summary: string } | null {
    const task = this.taskManager.getTask(taskId);
    if (!task) return null;

    const node = this.memoryTree.get(`checkpoint:${taskId}`);
    return { task, summary: node?.summary ?? '' };
  }

  /**
   * Возвращает последний чекпоинт (по updated_at в memory_tree).
   * Пропускает осиротевшие записи (где задача удалена).
   */
  getLatest(): { taskId: string; summary: string } | null {
    const nodes = this.memoryTree.getByLevel('checkpoint');
    if (nodes.length === 0) return null;

    const sorted = [...nodes].sort((a, b) => b.updated_at - a.updated_at);
    for (const node of sorted) {
      const taskId = node.path.replace('checkpoint:', '');
      const task = this.taskManager.getTask(taskId);
      if (task) {
        return { taskId, summary: node.summary };
      }
    }
    return null;
  }

  /**
   * Возвращает незавершённые задачи (статус pending или running).
   */
  listIncomplete(): TaskRow[] {
    return this.taskManager.getIncompleteTasks();
  }

  /**
   * Удаляет старые чекпоинты, оставляя только keepLast последних.
   * Удаляет как запись из memory_tree, так и задачу из таблицы tasks.
   */
  prune(keepLast: number): void {
    const nodes = this.memoryTree.getByLevel('checkpoint');
    const sorted = [...nodes].sort((a, b) => b.updated_at - a.updated_at);
    if (sorted.length <= keepLast) return;

    for (const node of sorted.slice(keepLast)) {
      const taskId = node.path.replace('checkpoint:', '');
      this.memoryTree.delete(node.path);
      this.taskManager.deleteTask(taskId);
    }
  }
}
