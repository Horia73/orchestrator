import type { Attachment } from "@/lib/types"

const MARKDOWN_UPLOAD_IMAGE_RE =
  /!\[[^\]]*\]\([^)]*?\/api\/uploads\/([A-Za-z0-9._%-]+)[^)]*\)/g

function decodeUploadId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Keep generated uploads as first-class message attachments for Library and
 * preview support, but do not render a second attachment card when an image is
 * already visible inline in the same assistant response.
 */
export function hideInlineImageAttachments(
  attachments: Attachment[] | undefined,
  renderedContent: string
): Attachment[] {
  if (!attachments?.length || !renderedContent) return attachments ?? []

  const inlineImageIds = new Set<string>()
  for (const match of renderedContent.matchAll(MARKDOWN_UPLOAD_IMAGE_RE)) {
    inlineImageIds.add(decodeUploadId(match[1]))
  }
  if (inlineImageIds.size === 0) return attachments

  return attachments.filter(
    (attachment) =>
      !(
        (attachment.type === "image" ||
          attachment.mimeType.startsWith("image/")) &&
        inlineImageIds.has(attachment.id)
      )
  )
}
