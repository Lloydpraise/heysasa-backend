# Exact `src/index.js` patch

## Add near the top, with the other local imports (right after the `startAlerts`/`config/evolution`/`config/supabase` import block is a natural spot):

```js
import personaRoutes from './personaRoutes.js';
```

## Add one line, anywhere after `app.use(express.json({ limit: '50mb' }));`

The cleanest spot is right after the existing analysis block — i.e. right after this bit that's already in your file:

```js
app.get('/analysis/status', async (req, res, next) => {
    ...
});
```

add directly below it:

```js
app.use(personaRoutes);
```

That's the whole patch — two lines, nothing else in `index.js` changes. `personaRoutes.js` defines its own `POST /persona/generate` and `GET /persona/status` routes (plus debug aliases `/debug/persona/generate`), so `app.use(personaRoutes)` just mounts them alongside everything else already on `app`.
