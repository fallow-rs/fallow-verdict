import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { recordSchema, type FindingRecord, type RunRecord } from "./schema.ts";

const LOCK_STALE_MS = 60 * 60 * 1000;

export type Store = {
  dataDir: string;
  candidatesPath: string;
  verdictsPath: string;
  reportPath: string;
  readRecords: () => Promise<{ records: FindingRecord[]; corrupt: string[] }>;
  writeRecord: (record: FindingRecord) => Promise<void>;
  writeRun: (run: RunRecord) => Promise<void>;
  writeJson: (file: string, value: unknown) => Promise<void>;
  readJson: (file: string) => Promise<Result<unknown, VerdictError>>;
  lock: () => Promise<Result<() => Promise<void>, VerdictError>>;
};

/** Temp file plus rename: a crash mid-write leaves the old record, never a torn one. */
const writeAtomic = async (file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
};

const recordFileName = (findingId: string): string =>
  `${createHash("sha256").update(findingId).digest("hex").slice(0, 24)}.json`;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readJson = async (file: string): Promise<Result<unknown, VerdictError>> => {
  try {
    return ok(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    return err(
      verdictError(
        "state_corrupt",
        missing ? `${file} does not exist.` : `${file} is not valid JSON.`,
        missing ? "Run `fallow-verdict scan` first." : undefined,
      ),
    );
  }
};

export const newRunId = (): string =>
  `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;

export const openStore = (dataDir: string): Store => {
  const findingsDir = path.join(dataDir, "findings");
  const runsDir = path.join(dataDir, "runs");
  const lockDir = path.join(dataDir, ".lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const recoveryDir = path.join(dataDir, ".lock-recovery");

  const writeJson = (file: string, value: unknown): Promise<void> =>
    writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

  const lockIsStale = async (): Promise<boolean> => {
    try {
      const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { pid?: number };
      if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0)
        return !isProcessAlive(owner.pid);
      return Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS;
    } catch {
      // A second process may observe the directory before its owner file exists.
      const info = await stat(lockDir).catch(() => null);
      return info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS;
    }
  };

  const lock: Store["lock"] = async () => {
    await mkdir(dataDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lockDir);
        await writeFile(
          ownerFile,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        return ok(() => rm(lockDir, { recursive: true, force: true }));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        if (!(await lockIsStale())) break;
        // Serialize recovery so a second reaper cannot remove a newly acquired lock.
        try {
          await mkdir(recoveryDir);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") break;
          throw recoveryError;
        }
        try {
          if (await lockIsStale()) await rm(lockDir, { recursive: true, force: true });
        } finally {
          await rm(recoveryDir, { recursive: true, force: true });
        }
      }
    }
    return err(
      verdictError(
        "state_locked",
        `Another fallow-verdict process holds ${lockDir}.`,
        "Wait for it to finish, or remove the directory if no process is running.",
      ),
    );
  };

  return {
    dataDir,
    candidatesPath: path.join(dataDir, "candidates.json"),
    verdictsPath: path.join(dataDir, "verdicts.json"),
    reportPath: path.join(dataDir, "report.md"),
    writeJson,
    readJson,
    lock,
    writeRecord: (record) =>
      writeJson(path.join(findingsDir, recordFileName(record.finding_id)), record),
    writeRun: (run) => writeJson(path.join(runsDir, `${run.runId}.json`), run),
    readRecords: async () => {
      const records: FindingRecord[] = [];
      const corrupt: string[] = [];
      const names = await readdir(findingsDir).catch(() => [] as string[]);
      for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
        const raw = await readJson(path.join(findingsDir, name));
        const parsed = raw.ok ? recordSchema.safeParse(raw.data) : null;
        // One unreadable record must not take the whole store down with it.
        if (parsed?.success) records.push(parsed.data);
        else corrupt.push(name);
      }
      return { records, corrupt };
    },
  };
};
