import { Router } from 'express';
import { request } from 'undici';

const router = Router();

// GET /api/map/tiles/:z/:x/:y — proxy SCIM tiles to bypass browser hotlink protection
router.get('/api/map/tiles/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  const upstream = `https://static.satisfactory-calculator.com/imgMap/gameLayer/Stable/${z}/${x}/${y}.png`;

  try {
    const { statusCode, headers, body } = await request(upstream, {
      headers: {
        'Referer': 'https://satisfactory-calculator.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (statusCode !== 200) {
      // Return a 1×1 transparent PNG for missing tiles (SCIM only generates tiles
      // where the game world exists — edges return 404). This silences console
      // errors and prevents Leaflet from flashing a white error placeholder.
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.send(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
        'base64',
      ));
      return;
    }

    res.setHeader('Content-Type', headers['content-type'] ?? 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // tiles don't change often
    body.pipe(res as unknown as NodeJS.WritableStream);
  } catch {
    res.status(502).end();
  }
});

export { router as mapTilesRouter };
