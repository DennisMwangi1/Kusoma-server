import sharp from "sharp";

import type { Attachment } from "../db/schema.js";
import { MAX_REQUEST_BYTES } from "./bedrock.js";
import { getFileUrl } from "./telegram.js";

/**
 * Attachment → vision content block (§9.0).
 *
 * Bedrock accepts NEITHER a Telegram file_id NOR a URL image source, and has
 * no Files API. Both attachment shapes from §5 must be resolved to base64
 * bytes server-side before they reach the model.
 */

/** Conservative per-image ceiling, well under Bedrock's 20 MB request cap. */
export const MAX_IMAGE_BYTES = Math.floor(MAX_REQUEST_BYTES / 4);

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
}

export const isImage = (a: Attachment): boolean => a.type === "image";

/** Infer a MIME type from a URL or fall back to jpeg. */
function inferMimeType(url: string): ImageMediaType {
  const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

const VALID_MEDIA_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
function toMediaType(mime: string | undefined): ImageMediaType {
  if (mime && VALID_MEDIA_TYPES.has(mime)) return mime as ImageMediaType;
  return "image/jpeg";
}

/**
 * Resize/recompress until the buffer is under `MAX_IMAGE_BYTES`. Converts to
 * JPEG when the source format (e.g. PNG) will not fit even at minimum width.
 */
async function downscaleToCap(buf: Buffer): Promise<{ bytes: Buffer; mediaType: ImageMediaType }> {
  const meta = await sharp(buf).metadata();
  const sourceType: ImageMediaType =
    meta.format === "png"
      ? "image/png"
      : meta.format === "webp"
        ? "image/webp"
        : meta.format === "gif"
          ? "image/gif"
          : "image/jpeg";

  if (buf.byteLength <= MAX_IMAGE_BYTES) {
    return { bytes: buf, mediaType: sourceType };
  }

  let width = Math.min(meta.width ?? 1600, 1600);
  let quality = 80;
  let asJpeg = sourceType === "image/jpeg" || sourceType === "image/gif";
  let out = buf;
  let mediaType: ImageMediaType = sourceType;

  for (let i = 0; i < 8; i++) {
    const pipeline = sharp(buf).rotate().resize({
      width: Math.max(width, 256),
      withoutEnlargement: true,
    });

    if (asJpeg) {
      out = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
      mediaType = "image/jpeg";
    } else if (sourceType === "image/webp") {
      out = await pipeline.webp({ quality }).toBuffer();
      mediaType = "image/webp";
    } else {
      out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      mediaType = "image/png";
    }

    if (out.byteLength <= MAX_IMAGE_BYTES) {
      return { bytes: out, mediaType };
    }

    console.warn(
      `attachments: ${buf.byteLength}b → ${out.byteLength}b still over cap, retrying width=${width} quality=${quality}`,
    );

    quality = Math.max(40, quality - 15);
    width = Math.floor(width * 0.7);
    // PNG rarely shrinks enough — switch to JPEG after the first miss.
    if (!asJpeg) asJpeg = true;
  }

  throw new Error(`image still ${out.byteLength}b after downscale (cap ${MAX_IMAGE_BYTES})`);
}

/** Fetch bytes from a URL. Size is enforced later by `downscaleToCap`. */
async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Resolve one attachment to a base64 vision block.
 *
 *   - a.telegramFileId → getFileUrl() → fetch bytes → base64
 *   - a.url            → server-side fetch → base64
 */
export async function toImageBlock(a: Attachment): Promise<ImageBlock | null> {
  let url: string | null = null;

  if (a.telegramFileId) {
    url = await getFileUrl(a.telegramFileId);
  } else if (a.url) {
    url = a.url;
  }

  if (!url) return null;

  const raw = await fetchBytes(url);
  const { bytes, mediaType: scaledType } = await downscaleToCap(raw);
  const mediaType =
    bytes === raw ? (a.mimeType ? toMediaType(a.mimeType) : inferMimeType(url)) : scaledType;

  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
  };
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
