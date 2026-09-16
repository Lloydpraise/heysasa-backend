const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document'])

export function normalizeOutboundMedia(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('media_must_be_an_object')

  const type = String(value.type || 'image').toLowerCase()
  if (!MEDIA_TYPES.has(type)) throw new Error(`unsupported_media_type:${type}`)

  const url = String(value.url || '').trim()
  if (!url) throw new Error('media_url_required')
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('media_url_invalid')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('media_url_must_be_http')

  const mimeType = value.mime_type == null ? null : String(value.mime_type).trim()
  const fileName = value.file_name == null ? null : String(value.file_name).trim()
  const caption = value.caption == null ? null : String(value.caption)

  return {
    type,
    url,
    mime_type: mimeType || null,
    file_name: fileName || null,
    caption
  }
}