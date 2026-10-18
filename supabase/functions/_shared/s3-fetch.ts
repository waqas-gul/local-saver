/**
 * The storage-janitor's S3 calls over a signed fetch (phase 3 §17.5, D-8): aws4fetch signs in the
 * Edge Function; nothing else is needed for DeleteObject, PutObject, CopyObject, HeadObject,
 * ListObjectsV2 and the multipart listing. Runtime-agnostic, like janitor-core.ts (no imports, no
 * runtime globals). CopyObject goes to a hold copy (RISK-031) or, for extend by copy (P4-15), to a
 * generated key of a longer-lived class; one request copies up to 5 GiB, Pro's largest file.
 *
 * Only single-object DeleteObject is used: DeleteObjects batches wait for R2 to confirm them
 * (RISK-011). Errors carry the HTTP status and S3 error code, never the key.
 */

export type SignedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`storage request failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "StorageError";
  }
}

const OBJECT_KEY = /^(d7|d30|d90|ws)\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertKey(key: string): void {
  if (!OBJECT_KEY.test(key)) throw new Error("invalid object key");
}

/** An extension copy's destination: a generated key in d30/ or d90/ (P4-15). */
function isExtensionKey(key: string): boolean {
  return OBJECT_KEY.test(key) && (key.startsWith("d30/") || key.startsWith("d90/"));
}

/** A generated key, or its legal-hold copy hold/<key> (RISK-031). */
function assertKeyOrHoldCopy(key: string): void {
  if (!OBJECT_KEY.test(key.startsWith("hold/") ? key.slice("hold/".length) : key)) throw new Error("invalid object key");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1] as string) : null;
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] as string);
}

async function check(response: Response, allowed: number[] = []): Promise<string> {
  const text = await response.text();
  if (response.ok || allowed.includes(response.status)) return text;
  throw new StorageError(response.status, tag(text, "Code"));
}

export function createFetchStorage(config: { endpoint: string; bucket: string; fetch: SignedFetch }) {
  const base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  // Generated keys contain only [a-z0-9/-]; each segment is still encoded.
  const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
  const objectUrl = (key: string) => `${base}/${encodeKey(key)}`;

  return {
    async deleteObject(key: string): Promise<void> {
      assertKeyOrHoldCopy(key);
      // A missing key is already deleted (idempotent).
      await check(await config.fetch(objectUrl(key), { method: "DELETE" }), [404]);
    },

    async putTombstone(key: string): Promise<void> {
      assertKey(key);
      await check(
        await config.fetch(objectUrl(key), {
          method: "PUT",
          body: new Uint8Array(0),
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-amz-meta-tombstone": "1" },
        }),
      );
    },

    /**
     * Server-side copy keeping the stored headers: a held object to hold/<key> (RISK-031), or an extended
     * share's object to its new key (P4-15).
     */
    async copyObject(sourceKey: string, destinationKey: string): Promise<"copied" | "missing"> {
      assertKey(sourceKey);
      if (destinationKey !== `hold/${sourceKey}` && !(isExtensionKey(destinationKey) && destinationKey !== sourceKey)) {
        throw new Error("invalid object key");
      }
      const response = await config.fetch(objectUrl(destinationKey), {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${encodeURIComponent(config.bucket)}/${encodeKey(sourceKey)}`,
          "x-amz-metadata-directive": "COPY",
        },
      });
      const text = await response.text();
      if (response.status === 404 && tag(text, "Code") === "NoSuchKey") return "missing";
      if (!response.ok) throw new StorageError(response.status, tag(text, "Code"));
      // CopyObject can report a failure inside a 200 response; only a CopyObjectResult is a copy.
      if (!/<CopyObjectResult[\s>]/.test(text)) throw new StorageError(response.status, tag(text, "Code") ?? "InvalidCopyResult");
      return "copied";
    },

    /** The object's size (HEAD Content-Length), or null when there is none. */
    async objectSize(key: string): Promise<number | null> {
      assertKey(key);
      const response = await config.fetch(objectUrl(key), { method: "HEAD" });
      await response.body?.cancel();
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageError(response.status, null);
      const length = response.headers.get("content-length");
      if (length === null || !/^\d+$/.test(length)) throw new StorageError(response.status, "NoContentLength");
      return Number(length);
    },

    async objectExists(key: string): Promise<boolean> {
      assertKeyOrHoldCopy(key);
      const response = await config.fetch(objectUrl(key), { method: "HEAD" });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status === 404) return false;
      throw new StorageError(response.status, null);
    },

    async listObjects(startAfter: string | null, maxKeys: number) {
      const params = new URLSearchParams({ "list-type": "2", "max-keys": String(maxKeys) });
      if (startAfter !== null) params.set("start-after", startAfter);
      const xml = await check(await config.fetch(`${base}?${params.toString().replace(/\+/g, "%20")}`));
      return {
        truncated: tag(xml, "IsTruncated") === "true",
        keys: blocks(xml, "Contents").map((block) => ({
          key: tag(block, "Key") ?? "",
          lastModified: new Date(tag(block, "LastModified") ?? 0),
        })),
      };
    },

    async listMultipartUploads() {
      const uploads: { key: string; uploadId: string; initiated: Date }[] = [];
      let keyMarker: string | null = null;
      let idMarker: string | null = null;
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams();
        if (keyMarker !== null) params.set("key-marker", keyMarker);
        if (idMarker !== null) params.set("upload-id-marker", idMarker);
        const query = params.toString();
        const xml = await check(await config.fetch(`${base}?uploads${query ? `&${query}` : ""}`));
        for (const block of blocks(xml, "Upload")) {
          uploads.push({
            key: tag(block, "Key") ?? "",
            uploadId: tag(block, "UploadId") ?? "",
            initiated: new Date(tag(block, "Initiated") ?? 0),
          });
        }
        if (tag(xml, "IsTruncated") !== "true") break;
        keyMarker = tag(xml, "NextKeyMarker");
        idMarker = tag(xml, "NextUploadIdMarker");
      }
      return uploads;
    },

    async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
      assertKey(key);
      await check(await config.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }), [404]);
    },
  };
}
