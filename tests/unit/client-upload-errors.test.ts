import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/client/api-error";
import { uploadErrorMessage } from "@/lib/client/uploader";

const apiError = (code: string, status = 409) => new ApiRequestError(status, code, "server message", "req-1");

describe("uploadErrorMessage", () => {
  it("explains the upload deadline and a share that ended during the upload", () => {
    expect(uploadErrorMessage(apiError("UPLOAD_EXPIRED"))).toBe("The upload took too long. Please start again.");
    expect(uploadErrorMessage(apiError("UPLOAD_REJECTED", 422))).toBe(
      "The upload didn't match what was announced, so it was rejected.",
    );
  });

  it("explains the storage quota", () => {
    expect(uploadErrorMessage(apiError("STORAGE_QUOTA_EXCEEDED"))).toBe("You've used your storage. Delete some uploads and try again.");
  });

  // Phase 4B: the limit that applied comes from the server (the caller's plan), Free's by default.
  it("states the plan's file size and file count limits", () => {
    const withDetails = (code: string, details: unknown) => new ApiRequestError(413, code, "server message", "req-1", details);
    expect(uploadErrorMessage(withDetails("FILE_TOO_LARGE", { maxFileBytes: 100 * 1024 * 1024 }))).toBe("A file is larger than 100 MB.");
    expect(uploadErrorMessage(apiError("FILE_TOO_LARGE", 413))).toBe("A file is larger than 100 MB.");
    expect(uploadErrorMessage(withDetails("TOO_MANY_FILES", { maxFiles: 100 }))).toBe("You can share up to 100 files at once.");
    expect(uploadErrorMessage(apiError("TOO_MANY_FILES", 413))).toBe("You can share up to 20 files at once.");
  });
});
