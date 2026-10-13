// Ad thumbnails from WhatsApp/Meta are links that expire. Copy the picture into our own storage (the same bucket
// campaign images use) so the playbook, the editor and the follow-up media keep working.

import { log } from '../lib/log.js'

const BUCKET = 'customer_images'
const MAX_BYTES = 5 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export const isOurStorageUrl = (url) => String(url ?? '').includes(`/storage/v1/object/public/${BUCKET}/`)

// Only public web addresses: never the machine itself or the private network.
export function isSafeRemoteUrl(value) {
  let u
  try { u = new URL(value) } catch { return false }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^\[/.test(host) || host.includes(':')) return false
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false
  }
  return true
}

async function download(url) {
  if (url.startsWith('data:image/')) {
    const match = url.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i)
    if (!match) return null
    const buffer = Buffer.from(match[2], 'base64')
    return buffer.length && buffer.length <= MAX_BYTES ? { buffer, type: match[1].toLowerCase() } : null
  }
  if (!isSafeRemoteUrl(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!EXT[type]) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length && buffer.length <= MAX_BYTES ? { buffer, type } : null
  } finally {
    clearTimeout(timer)
  }
}

// Returns our own public URL, or null if the picture could not be fetched (expired link, not an image, too big).
export async function persistAdImage(supabase, businessId, adId, url) {
  if (!url) return null
  if (isOurStorageUrl(url)) return url
  try {
    const file = await download(url)
    if (!file) return null
    const path = `${businessId}/ads/${String(adId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'ad'}-${Date.now()}.${EXT[file.type]}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.type, upsert: false })
    if (error) throw error
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return data?.publicUrl ?? null
  } catch (e) {
    log('warn', 'followup_ai', 'followup_ai.ad_image_failed', `Ad image not saved: ${e?.message ?? e}`, { business_id: businessId, details: { adId } })
    return null
  }
}
