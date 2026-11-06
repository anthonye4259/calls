import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallPatch, CallRecord, TranscriptEntry } from "./domain.js";

export interface CallRepository {
  create(record: CallRecord): Promise<CallRecord>;
  get(id: string): Promise<CallRecord | undefined>;
  list(): Promise<CallRecord[]>;
  update(id: string, patch: CallPatch): Promise<CallRecord>;
  appendTranscript(id: string, entry: TranscriptEntry): Promise<CallRecord>;
}

export class JsonCallRepository implements CallRepository {
  private records = new Map<string, CallRecord>();
  private initialized = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const content = await readFile(this.filePath, "utf8");
      const records = JSON.parse(content) as CallRecord[];
      records.forEach((record) => this.records.set(record.id, record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify([...this.records.values()], null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async create(record: CallRecord) {
    await this.initialize();
    this.records.set(record.id, structuredClone(record));
    await this.persist();
    return structuredClone(record);
  }

  async get(id: string) {
    await this.initialize();
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list() {
    await this.initialize();
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => structuredClone(record));
  }

  async update(id: string, patch: CallPatch) {
    await this.initialize();
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Call ${id} was not found`);
    const updated = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.records.set(id, updated);
    await this.persist();
    return structuredClone(updated);
  }

  async appendTranscript(id: string, entry: TranscriptEntry) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Call ${id} was not found`);
    return this.update(id, { transcript: [...existing.transcript, entry] });
  }
}

export class MemoryCallRepository implements CallRepository {
  private records = new Map<string, CallRecord>();

  async create(record: CallRecord) {
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async update(id: string, patch: CallPatch) {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Call ${id} was not found`);
    const updated = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.records.set(id, updated);
    return structuredClone(updated);
  }

  async appendTranscript(id: string, entry: TranscriptEntry) {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Call ${id} was not found`);
    return this.update(id, { transcript: [...existing.transcript, entry] });
  }
}
