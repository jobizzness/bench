import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, StoredAttachment } from "../shared/types.js";

/**
 * What the Anthropic API will look at. Anything else is refused rather than
 * forwarded: a PDF or an SVG that reaches the CLI as an image block is an
 * error from the model, several seconds and a full conversation resend later,
 * rather than an error here.
 */
export const ACCEPTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** How much image one prompt may carry, decoded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** How many images one prompt may carry. */
export const MAX_IMAGE_COUNT = 8;

/**
 * The request body cap. `readBody` had no cap at all, so before images this
 * was a route that would buffer whatever it was sent.
 *
 * Deliberately a megabyte clear of the image cap once base64's third is
 * accounted for. The two limits catch different things and the developer
 * should meet the useful one: an image slightly over the limit gets "over the
 * 5 MB limit", which says what to do about it, rather than a body refused
 * before anything has looked at what is in it.
 */
export const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** What a stored image is allowed to be called, so a name off the wire can
 * never climb out of the directory it belongs in. */
const STORED_NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

/** The decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/**
 * Why a set of attachments was refused, or null when they are fine.
 *
 * Returns the reason rather than throwing because every caller wants to put
 * it in front of the developer: "too big" and "wrong sort of file" are things
 * they can act on, and a generic 400 is not.
 */
export function attachmentProblem(images: Attachment[]): string | null {
  if (images.length > MAX_IMAGE_COUNT) {
    return `at most ${MAX_IMAGE_COUNT} images per message`;
  }

  let total = 0;
  for (const image of images) {
    if (!ACCEPTED_MEDIA_TYPES.includes(image.mediaType)) {
      return `${image.mediaType} is not an image bench can send`;
    }
    if (image.data === "") return "an image arrived empty";
    total += base64Bytes(image.data);
  }

  if (total > MAX_IMAGE_BYTES) {
    return `images total ${Math.round(total / 1024 / 1024 * 10) / 10} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`;
  }
  return null;
}

/**
 * The `images` field off a request body, or null when it is malformed.
 *
 * An absent field is not malformed - it is the ordinary text-only message,
 * which is most of them - so that reads as an empty list.
 */
export function readAttachments(value: unknown): Attachment[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const images: Attachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { mediaType, data } = item as Record<string, unknown>;
    if (typeof mediaType !== "string" || typeof data !== "string") return null;
    images.push({ mediaType, data });
  }
  return images;
}

/**
 * Put the bytes on disk beside the thread and hand back what to record.
 *
 * The thread is a JSONL file re-read in full on every load, so an image in it
 * would be paid for on every reload of the cockpit rather than once. The
 * reference is what goes in the thread; this is where the picture goes.
 */
export async function storeAttachments(
  reportsDir: string,
  images: Attachment[],
): Promise<StoredAttachment[]> {
  if (images.length === 0) return [];

  const dir = join(reportsDir, "images");
  await mkdir(dir, { recursive: true });

  const stored: StoredAttachment[] = [];
  for (const image of images) {
    const name = `${randomUUID()}.${EXTENSIONS[image.mediaType]}`;
    await writeFile(join(dir, name), Buffer.from(image.data, "base64"));
    stored.push({ ...image, name });
  }
  return stored;
}

/** What to serve a stored image as, read back off its own name. */
export function mediaTypeForName(name: string): string {
  const extension = name.split(".").pop() ?? "";
  return Object.keys(EXTENSIONS).find((type) => EXTENSIONS[type] === extension)
    ?? "application/octet-stream";
}

/**
 * Where a stored image lives, or null when the name is not one bench wrote.
 *
 * The name is the only client-supplied part of the serving route's path, so
 * it is matched against the shape bench generates rather than sanitised: a
 * pattern that only accepts a UUID and a known extension cannot express
 * `..` at all.
 */
export function attachmentPath(reportsDir: string, name: string): string | null {
  if (!STORED_NAME.test(name)) return null;
  return join(reportsDir, "images", name);
}
