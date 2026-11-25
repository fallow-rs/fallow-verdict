import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Temp file plus rename: a crash mid-write leaves the old file, never a torn one. */
export const writeAtomic = async (file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
};

/**
 * Reads a file inside the root. Resolving through realpath keeps a crafted or symlinked path
 * from pulling a file outside the project into a request. Any failure gives null.
 */
export const readContainedBytes = async (
  root: string,
  relative: string,
): Promise<Buffer | null> => {
  try {
    const realRoot = await realpath(root);
    const resolved = await realpath(path.resolve(realRoot, relative));
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return null;
    return await readFile(resolved);
  } catch {
    return null;
  }
};

/** True when `file` is `scope` or inside it. Both are relative to `root`. */
export const isInside = (root: string, scope: string, file: string): boolean => {
  const relative = path.relative(path.resolve(root, scope), path.resolve(root, file));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const gitHeads = new Map<string, Promise<string>>();

/** The current Git commit, or `none`. It is read once for each root in one process: a run does not commit. */
export const gitHead = (root: string): Promise<string> => {
  const known = gitHeads.get(root);
  if (known !== undefined) return known;
  const head = new Promise<string>((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 10_000 }, (error, stdout) =>
      resolve(error === null ? stdout.trim() : "none"),
    );
  });
  gitHeads.set(root, head);
  return head;
};
