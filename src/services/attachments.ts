import type { Attachment } from "../db/schema.js";
import { BEDROCK_MAX_REQUEST_BYTES } from "./bedrock.js";
import { getFileUrl } from "./telegram.js";

/**
 * Attachment → vision content block (§9.0).
 *
 * Bedrock accepts NEITHER a Telegram file_id NOR a URL image source, and has
 * no Files API. Both attachment shapes from §5 must be resolved to base64
 * bytes server-side before they reach the model. That is what this file is
 * for, and it is the single reason attachments need any server-side work at
 * all beyond storing metadata.
 *
 * SCAFFOLD (§16): the resolution path below is deliberately unimplemented.
 * The signatures, the size guard, and the failure policy are here so Phase 5
 * has a shaped hole to fill rather than a decision to re-make.
 */

/** Conservative per-image ceiling, well under Bedrock's 20 MB request cap. */
export const MAX_IMAGE_BYTES = Math.floor(BEDROCK_MAX_REQUEST_BYTES / 4);

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export const isImage = (a: Attachment): boolean => a.type === "image";

/**
 * Resolve one attachment to a base64 vision block.
 *
 * TODO(phase-5): implement both branches.
 *   - a.telegramFileId -> getFileUrl() -> fetch bytes -> base64
 *   - a.url            -> server-side fetch -> base64
 * Downscale anything over MAX_IMAGE_BYTES rather than letting the Bedrock
 * call fail on payload size; a student sending three homework photos is the
 * normal case, not the edge case.
 */
export async function toImageBlock(_a: Attachment): Promise<ImageBlock | null> {
  // TODO(phase-5): see above. Returning null keeps the orchestrator's
  // text-only path working today.
  return null;
}

/**
 * Resolve every image attachment on a message, dropping the ones that fail.
 *
 * A failed attachment must never fail the whole reply — the student still
 * asked a question, and answering it without the photo beats answering
 * nothing.
 */
export async function toImageBlocks(attachments: Attachment[]): Promise<ImageBlock[]> {
  const blocks = await Promise.all(
    attachments.filter(isImage).map((a) =>
      toImageBlock(a).catch((err) => {
        console.error("attachments: failed to resolve", err);
        return null;
      }),
    ),
  );
  return blocks.filter((b): b is ImageBlock => b !== null);
}

export { getFileUrl };
