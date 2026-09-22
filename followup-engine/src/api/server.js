import express from 'express'
import cors from 'cors'
import { requireBusinessAuth } from './authMiddleware.js'
import { queueRouter } from './queueRoutes.js'
import { followupSettingsRouter } from './followupSettingsRoutes.js'
import { materialsRouter } from './materialsRoutes.js'
import { whatsappRouter } from './whatsappRoutes.js'
import { campaignRouter } from './campaignRoutes.js'
import { CORS_ORIGINS } from '../config.js'
import { log } from '../lib/log.js'

const PORT = parseInt(process.env.PORT ?? '3001')

const app = express()
app.use(cors({
  origin: (origin, callback) => {
    const isLocalDevelopmentOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '')
    const isConfiguredOrigin = !origin || CORS_ORIGINS.includes(origin)
    callback(null, isLocalDevelopmentOrigin || isConfiguredOrigin)
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Business-Id'],
}))
app.use(express.json())

// Logs every request to this API (the one the dashboard talks to). Reads
// req.businessId lazily on 'finish', after requireBusinessAuth (below)
// has had a chance to set it — so an authenticated request is logged
// with its business attached, and a rejected one is still logged, just
// without it. Only warns/errors persist to system_logs (see
// debugConsole.js); 2xx/3xx traffic stays in the live buffer as 'debug'
// so routine polling doesn't fill up the history table.
app.use((req, res, next) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug'
    log(level, 'api', 'api.request', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
      business_id: req.businessId ?? null,
      duration_ms: durationMs,
      details: { method: req.method, path: req.originalUrl, status: res.statusCode },
    })
  })
  next()
})

app.use(requireBusinessAuth)
app.use(queueRouter)
app.use(followupSettingsRouter)
app.use(materialsRouter)
app.use(whatsappRouter)
app.use(campaignRouter)

app.listen(PORT, () => {
  console.log(`[API] Listening on :${PORT}`)
  log('info', 'api', 'api.started', `Follow-up API listening on :${PORT}`, { details: { port: PORT } })
})
