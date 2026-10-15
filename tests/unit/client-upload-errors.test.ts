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
});
