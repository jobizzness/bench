import { useState } from "react";
import type { Attachment } from "../../shared/types.js";

const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const MAX_LONG_EDGE = 1568;
const ACCEPTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Returns the decoded byte length of a base64 string.
 */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/**
 * Process an image file: downscales if over 1568px on either edge,
 * and converts to base64 with MIME type.
 */
function processImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    if (!ACCEPTED_MEDIA_TYPES.includes(file.type)) {
      reject(new Error(`${file.type || "file"} is not an image bench can send`));
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const width = img.width;
      const height = img.height;

      if (width <= MAX_LONG_EDGE && height <= MAX_LONG_EDGE) {
        // Under the size limit, read the file directly as base64 to preserve original bytes
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result as string;
          const comma = res.indexOf(",");
          if (comma === -1) {
            reject(new Error("Failed to read image"));
          } else {
            resolve({ mediaType: file.type, data: res.slice(comma + 1) });
          }
        };
        reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
        reader.readAsDataURL(file);
      } else {
        // Over the size limit, downscale it using canvas
        let newWidth = width;
        let newHeight = height;
        if (width > height) {
          newHeight = Math.round((height * MAX_LONG_EDGE) / width);
          newWidth = MAX_LONG_EDGE;
        } else {
          newWidth = Math.round((width * MAX_LONG_EDGE) / height);
          newHeight = MAX_LONG_EDGE;
        }

        const canvas = document.createElement("canvas");
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not scale image"));
          return;
        }
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        const dataUrl = canvas.toDataURL(file.type);
        const comma = dataUrl.indexOf(",");
        if (comma === -1) {
          reject(new Error("Failed to scale image"));
        } else {
          resolve({ mediaType: file.type, data: dataUrl.slice(comma + 1) });
        }
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };

    img.src = url;
  });
}

/**
 * Hook to manage selected image attachments for a composer.
 * Handles dropping, pasting, and browsing files with size limits and downscaling.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (files: FileList | File[]) => {
    setError(null);
    const list = Array.from(files);

    if (attachments.length + list.length > MAX_IMAGE_COUNT) {
      setError(`At most ${MAX_IMAGE_COUNT} images per message`);
      return;
    }

    try {
      const processed = await Promise.all(list.map((f) => processImage(f)));

      // Calculate total bytes of current + new
      const newAttachments = [...attachments, ...processed];
      const totalBytes = newAttachments.reduce((sum, att) => sum + base64Bytes(att.data), 0);

      if (totalBytes > MAX_IMAGE_BYTES) {
        setError(`Images total ${Math.round(totalBytes / 1024 / 1024 * 10) / 10} MB, over the 5 MB limit`);
        return;
      }

      setAttachments(newAttachments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load image");
    }
  };

  const removeAttachment = (index: number) => {
    setError(null);
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const clearAttachments = () => {
    setError(null);
    setAttachments([]);
  };

  /** Puts a set of already-processed attachments back, no re-reading or
   * re-scaling involved - but only into a box nobody has since attached
   * something new to. For one caller: a send that cleared these
   * optimistically and then failed - nothing typed or attached is lost
   * (#86), the same precedent #60 set for a failed decision answer, unless
   * the developer has already moved on to a new draft, in which case
   * putting a stale one back over it would be worse than the failure.
   * Reads the live count through the updater rather than whatever
   * `attachments` closed over at call time, since this runs from inside a
   * `catch` after an await - the same reason `App.tsx`'s `submit` does not
   * just re-check `attachments.length` directly. Not for new files, which
   * still want `addFiles`. */
  const restoreIfEmpty = (images: Attachment[]) => {
    setError(null);
    setAttachments((current) => (current.length === 0 ? images : current));
  };

  return {
    attachments,
    error,
    setError,
    addFiles,
    removeAttachment,
    clearAttachments,
    restoreIfEmpty,
  };
}
