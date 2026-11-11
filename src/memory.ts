import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export interface MemoryNote {
  id: string;
  text: string;
  /** Who saved it: the voice during a call, or an agent through the MCP tools. */
  source: "voice" | "agent";
  at: string;
}

const MAX_NOTES = 200;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Long-term notes about the user, shared by the voice and the agents (e.g. "Doesn't like Lattafa Khamrah, too
 * common"). Kept in a small JSON file; put it on a persistent volume or it resets on every redeploy.
 */
export class MemoryStore {
  private notes: MemoryNote[] = [];
  private writable = true;

  constructor(private file: string | null) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { notes?: MemoryNote[] };
      this.notes = Array.isArray(data.notes) ? data.notes : [];
      log.info(`memory: loaded ${this.notes.length} note(s) from ${file}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`memory: couldn't read ${file}: ${(e as Error).message}`);
    }
  }

  list(): MemoryNote[] {
    return [...this.notes];
  }

  /** Save a note; a near-duplicate of an existing note replaces it instead of piling up. */
  add(text: string, source: MemoryNote["source"]): MemoryNote {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 300);
    const key = normalize(clean);
    this.notes = this.notes.filter((n) => normalize(n.text) !== key);
    const note: MemoryNote = { id: randomUUID().slice(0, 8), text: clean, source, at: new Date().toISOString() };
    this.notes.push(note);
    if (this.notes.length > MAX_NOTES) this.notes = this.notes.slice(-MAX_NOTES);
    this.save();
    return note;
  }

  remove(id: string): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.file || !this.writable) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ notes: this.notes }, null, 2));
      renameSync(tmp, this.file); // atomic: a crash mid-write can't corrupt the file
    } catch (e) {
      this.writable = false; // keep working from memory; warn once
      log.warn(
        `memory: can't write ${this.file} (${(e as Error).message}). Notes will last until the next restart. ` +
          "On Railway, attach a volume and check the server can write to it.",
      );
    }
  }
}
