import fs from "fs";
import path from "path";

export interface CompletedDispatch {
  agent: string;
  task: string;
  sessionId?: string;
  artifactPath?: string;
  resultSummary?: string;
}

export interface PendingDispatch {
  agent: string;
  task: string;
  dependsOn?: string[];
}

export interface CheckpointState {
  checkpointId: string;
  task: string;
  mode: "orchestrate" | "pipeline" | "direct";
  sessionId: string;
  parentCheckpointId?: string;
  completedDispatches: CompletedDispatch[];
  pendingDispatches: PendingDispatch[];
  artifacts: string[];
  contextUsed: number;
  summaryFile: string;
  createdAt: string;
}

export class CheckpointManager {
  private baseDir: string;

  constructor(projectDir: string) {
    this.baseDir = path.join(projectDir, ".deus", "checkpoints");
  }

  save(state: CheckpointState, summary: string): string {
    const checkpointDir = path.join(this.baseDir, state.checkpointId);
    fs.mkdirSync(checkpointDir, { recursive: true });

    // Атомарная запись: write to temp → rename
    const stateTemp = path.join(checkpointDir, "state.tmp");
    const stateFile = path.join(checkpointDir, "state.json");
    const summaryFile = path.join(checkpointDir, "summary.md");

    fs.writeFileSync(stateTemp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(stateTemp, stateFile);

    fs.writeFileSync(summaryFile, summary, "utf-8");

    return state.checkpointId;
  }

  load(checkpointId: string): { state: CheckpointState; summary: string } | null {
    const checkpointDir = path.join(this.baseDir, checkpointId);
    const stateFile = path.join(checkpointDir, "state.json");
    const summaryFile = path.join(checkpointDir, "summary.md");

    if (!fs.existsSync(stateFile) || !fs.existsSync(summaryFile)) {
      return null;
    }

    try {
      const state: CheckpointState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const summary = fs.readFileSync(summaryFile, "utf-8");
      return { state, summary };
    } catch {
      return null;
    }
  }

  list(): CheckpointState[] {
    if (!fs.existsSync(this.baseDir)) return [];

    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const states: CheckpointState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(this.baseDir, entry.name, "state.json");
      if (!fs.existsSync(stateFile)) continue;
      try {
        const state: CheckpointState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        states.push(state);
      } catch {
        // skip corrupted
      }
    }

    // сортировка по createdAt, новые первые
    states.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return states;
  }

  getLatest(): CheckpointState | null {
    const states = this.list();
    return states.length > 0 ? states[0] : null;
  }

  prune(keepLast: number): void {
    const states = this.list();
    if (states.length <= keepLast) return;

    const toDelete = states.slice(keepLast);
    for (const state of toDelete) {
      const dir = path.join(this.baseDir, state.checkpointId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
