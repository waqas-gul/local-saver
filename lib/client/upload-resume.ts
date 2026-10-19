import { z } from "zod";

/**
 * Resume metadata for uploads with a multipart file (phase 4 §17.8.1, D4-25): which share and files are
 * still waiting for their bytes, so a reload can offer to finish them. localStorage holds only this small
 * metadata, scoped to the user who started the upload: never URLs, upload IDs, ETags or file contents.
 * The browser can't keep the File itself, so the user picks it again; the server's part list
 * (GET …/multipart, ListParts) says what is already uploaded, so nothing here is trusted for that.
 * Storage may be unavailable or throw (private windows, blocked site data): every access is guarded,
 * and without it an upload simply can't be resumed after a reload.
 */

const STORAGE_KEY = "localsaver.upload-resume.v1";

const resumeFile = z.object({
  fileId: z.uuid(),
  name: z.string().max(1024),
  size: z.number().int().positive(),
  lastModified: z.number().int(),
  multipart: z.boolean(),
});
export type ResumeFile = z.infer<typeof resumeFile>;

const resumeEntry = z.object({
  userId: z.string().min(1).max(100),
  shareId: z.uuid(),
  /** The upload deadline: after it the share has failed and the entry is dropped. */
  expiresAt: z.iso.datetime({ offset: true }),
  files: z.array(resumeFile).min(1).max(100),
});
export type ResumeEntry = z.infer<typeof resumeEntry>;

function readAll(): ResumeEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = z.array(resumeEntry).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ResumeEntry[]): void {
  try {
    if (entries.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Without storage the upload still runs; it just can't be resumed after a reload.
  }
}

/** This user's unexpired entries; expired ones (anyone's) are dropped on the way. */
export function readResume(userId: string, now = Date.now()): ResumeEntry[] {
  const all = readAll();
  const live = all.filter((e) => Date.parse(e.expiresAt) > now);
  if (live.length !== all.length) writeAll(live);
  return live.filter((e) => e.userId === userId);
}

export function saveResume(entry: ResumeEntry): void {
  writeAll([...readAll().filter((e) => e.shareId !== entry.shareId), entry]);
}

/** A file finished: forget it, and the entry once nothing is left. */
export function dropResumeFile(shareId: string, fileId: string): void {
  writeAll(
    readAll()
      .map((e) => (e.shareId === shareId ? { ...e, files: e.files.filter((f) => f.fileId !== fileId) } : e))
      .filter((e) => e.files.length > 0),
  );
}

export function dropResume(shareId: string): void {
  writeAll(readAll().filter((e) => e.shareId !== shareId));
}
