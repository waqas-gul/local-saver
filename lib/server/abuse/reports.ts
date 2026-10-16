import "server-only";
import type { z } from "zod";
import type { createReportBody } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import { requireCaller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import { log } from "../log";
import { requireViewerAccess } from "../links/grants";
import { currentNetwork } from "../network/current";
import { requesterKey } from "../network/requester";
import { enforceRateLimit } from "../ratelimit/limits";
import { turnstileConfigured, verifyTurnstile } from "../security/turnstile";
import { findVisibleShare } from "../shares/read";

/**
 * Abuse reports (03 §7.6, 05 §6 Phase 2). Anyone who can see a share may report it: a device
 * on its network or its creator (through the local API), or a link viewer holding a grant for
 * one of its links. Nobody can report what they cannot see, so reports can't be used to probe
 * for shares. Limits: 10 an hour per network key and per reporter, plus Turnstile wherever the
 * server verifies it (every deployment).
 *
 * Every report is stored, audited (report.created) and logged at warn level as
 * abuse.report_received. Nothing delivers that event to a person yet: the alert "every new
 * report" (08 §8), its channel and the operator are future requirements (Q-022; owner decision
 * 2026-10-16). Operators act through the takedown SQL functions (runbooks/takedown.md).
 */

type Body = z.infer<typeof createReportBody>;

type Target = {
  shareId: string;
  linkId: string | null;
  networkSpaceId: string | null;
  reporterKind: "device" | "link_viewer";
  reporterUserId: string | null;
  reporterDeviceId: string | null;
  /** Rate-limit subject for this reporter (device or link session). */
  reporter: string;
};

async function resolveTarget(request: Request, env: Env, body: Body): Promise<Target> {
  if (body.target.type === "link") {
    // A link viewer: needs a live grant for this very link (404 LINK_UNAVAILABLE otherwise).
    const access = await requireViewerAccess(request, env, body.target.linkId);
    return {
      shareId: access.shareId,
      linkId: access.linkId,
      networkSpaceId: access.networkSpaceId,
      reporterKind: "link_viewer",
      reporterUserId: null,
      reporterDeviceId: null,
      reporter: `session:${access.sessionHash.toString("hex")}`,
    };
  }
  // A device: the visibility rule decides, exactly as for reading the share (404 otherwise).
  const caller = await requireCaller(request, env);
  const network = await currentNetwork(request, env);
  const share = await findVisibleShare(caller, network, body.target.shareId);
  // A claimed burn share can still be reported by those who can see it (its claimant, its creator).
  if (!share || (share.status !== "active" && share.status !== "claimed")) throw notFound();
  return {
    shareId: share.id,
    linkId: null,
    networkSpaceId: share.networkSpaceId,
    reporterKind: "device",
    reporterUserId: caller.principal.userId,
    reporterDeviceId: caller.device.id,
    reporter: `device:${caller.device.id}`,
  };
}

export async function createReport(request: Request, env: Env, body: Body): Promise<{ id: string }> {
  const target = await resolveTarget(request, env, body);
  await enforceRateLimit("reportNetwork", requesterKey(request, env));
  await enforceRateLimit("reportReporter", target.reporter);
  if (turnstileConfigured(env) && !(await verifyTurnstile(env, body.turnstileToken))) {
    throw new ApiError(403, "TURNSTILE_REQUIRED", "Confirm you're a person to send this report", { turnstile: true });
  }

  const report = await getDb().transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("app.abuse_reports")
      .values({
        link_id: target.linkId,
        share_id: target.shareId,
        network_space_id: target.networkSpaceId,
        category: body.category,
        details: body.details?.trim() || null,
        reporter_email: body.email ?? null,
        reporter_kind: target.reporterKind,
        reporter_user_id: target.reporterUserId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(trx, {
      action: "report.created",
      actorKind: target.reporterKind,
      actorUserId: target.reporterUserId,
      actorDeviceId: target.reporterDeviceId,
      networkSpaceId: target.networkSpaceId,
      targetType: "report",
      targetId: inserted.id,
      metadata: { category: body.category, shareId: target.shareId, linkId: target.linkId },
    });
    return inserted;
  });

  // Structured log event for a future operator alert (08 §8, Q-022): IDs and category only,
  // never details or the email.
  log.warn("abuse.report_received", {
    reportId: report.id,
    category: body.category,
    via: target.reporterKind,
    urgent: body.category === "child_safety",
  });
  return { id: report.id };
}
