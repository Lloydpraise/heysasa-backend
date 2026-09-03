// Runs all three pieces in a single process — fine for one server today.
// When 03 (WABA) is added, or if these ever need to scale
// independently, split into separate deployments using
// `npm run start:scheduler`, `npm run start:sender-baileys`, and
// `npm run start:api`.
import './scheduler/run.js'
import './sender-baileys/run.js'
import './api/server.js'