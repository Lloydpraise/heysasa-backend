import express from 'express'
import cors from 'cors'
import { requireBusinessAuth } from './authMiddleware.js'
import { queueRouter } from './queueRoutes.js'
import { followupSettingsRouter } from './followupSettingsRoutes.js'
import { materialsRouter } from './materialsRoutes.js'
import { whatsappRouter } from './whatsappRoutes.js'
import { CORS_ORIGINS } from '../config.js'

const PORT = parseInt(process.env.PORT ?? '3001')

const app = express()
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Business-Id'],
}))
app.use(express.json())
app.use(requireBusinessAuth)
app.use(queueRouter)
app.use(followupSettingsRouter)
app.use(materialsRouter)
app.use(whatsappRouter)

app.listen(PORT, () => {
  console.log(`[API] Listening on :${PORT}`)
})