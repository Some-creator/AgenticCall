import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";

test("memory persists to disk, dedupes, and forgets", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mem-")), "sub", "memory.json");
  const m = new MemoryStore(file);
  const a = m.add("Doesn't like Khamrah", "voice");
  m.add("doesn't like   khamrah!", "agent"); // near-duplicate replaces, not piles up
  m.add("Gym at 8pm on weekdays", "agent");
  assert.deepEqual(m.list().map((n) => n.text), ["doesn't like khamrah!", "Gym at 8pm on weekdays"]);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).notes.length === 2);

  const reloaded = new MemoryStore(file);
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.remove(a.id), false); // replaced earlier, so the old id is gone
  assert.equal(reloaded.remove(reloaded.list()[0].id), true);
  assert.equal(new MemoryStore(file).list().length, 1);
});
