import { Router } from 'express'
import { supabase } from '../supabaseClient.js'
import { log } from '../lib/log.js'

export const materialsRouter = Router()

const VALID_TYPES = ['testimonial', 'tip', 'offer', 'story', 'educational']

// GET /materials — list all materials for this business
materialsRouter.get('/materials', async (req, res) => {
  const { data, error } = await supabase
    .from('followup_materials')
    .select('id, material_type, title, content, image_url, is_active, expires_at, created_at')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  // UI field is 'type', DB column is 'material_type' — translate here
  // rather than making the frontend know the DB's naming
  res.json({ materials: data.map(m => ({ ...m, type: m.material_type })) })
})

// POST /materials — create
materialsRouter.post('/materials', async (req, res) => {
  const { type, title, content, is_active, expires_at, image_url } = req.body ?? {}

  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type' })
  if (!title?.trim()) return res.status(400).json({ error: 'title_required' })
  if (!content?.trim()) return res.status(400).json({ error: 'content_required' })

  const { data, error } = await supabase
    .from('followup_materials')
    .insert({
      business_id: req.businessId,
      material_type: type,
      title: title.trim(),
      content: content.trim(),
      is_active: is_active ?? true,
      expires_at: expires_at || null,
      image_url: image_url || null
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  log('info', 'api', 'materials.created', `Created ${data.id} for business ${req.businessId}`, { business_id: req.businessId, entity_id: data.id })
  res.status(201).json({ ...data, type: data.material_type })
})

// PUT /materials/:id — update
materialsRouter.put('/materials/:id', async (req, res) => {
  const { id } = req.params
  const { type, title, content, is_active, expires_at, image_url } = req.body ?? {}

  // Confirm ownership before writing
  const { data: existing, error: fetchErr } = await supabase
    .from('followup_materials').select('business_id').eq('id', id).single()
  if (fetchErr || !existing) return res.status(404).json({ error: 'not_found' })
  if (existing.business_id !== req.businessId) return res.status(403).json({ error: 'forbidden' })

  if (type && !VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type' })

  const update = {}
  if (type !== undefined) update.material_type = type
  if (title !== undefined) update.title = title.trim()
  if (content !== undefined) update.content = content.trim()
  if (is_active !== undefined) update.is_active = is_active
  if (expires_at !== undefined) update.expires_at = expires_at || null
  if (image_url !== undefined) update.image_url = image_url || null

  const { data, error } = await supabase
    .from('followup_materials').update(update).eq('id', id).select().single()

  if (error) return res.status(500).json({ error: error.message })

  log('info', 'api', 'materials.updated', `Updated ${id} for business ${req.businessId}`, { business_id: req.businessId, entity_id: id })
  res.json({ ...data, type: data.material_type })
})

// DELETE /materials/:id
materialsRouter.delete('/materials/:id', async (req, res) => {
  const { id } = req.params

  const { data: existing, error: fetchErr } = await supabase
    .from('followup_materials').select('business_id').eq('id', id).single()
  if (fetchErr || !existing) return res.status(404).json({ error: 'not_found' })
  if (existing.business_id !== req.businessId) return res.status(403).json({ error: 'forbidden' })

  const { error } = await supabase.from('followup_materials').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  log('info', 'api', 'materials.deleted', `Deleted ${id} for business ${req.businessId}`, { business_id: req.businessId, entity_id: id })
  res.status(204).send()
})