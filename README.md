# Draw History

Draw History is a browser-based historical geometry editor using MapLibre GL JS, Turf.js, GeoJSON, a module Web Worker, and Supabase.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_MAPTILER_KEY` to a MapTiler key restricted to your site's allowed origins. A full style URL may also be supplied; the application keeps the specified satellite style.
3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable the real public archive, publishing, and authentication.
4. Install and start: `npm install`, then `npm run dev`. Open the `127.0.0.1` URL printed by Vite; local MapTiler restrictions can distinguish it from `localhost`.

The Supabase client requires only the public anon/publishable key. Never put a service-role key in frontend configuration. Run `supabase-schema.sql` in the intended Supabase project to create the table and owner-enforced row-level security policies.

## Editor

The studio supports polygon drawing, screen-space snapping, selecting and deleting whole shapes, inserting and dragging polygon vertices, GeoJSON import/export, local browser autosave, and geometry undo/redo. The Delete tool only removes an entire shape; it never removes vertices. Water Mask runs in a Web Worker and requires the Natural Earth `ne_10m_ocean.geojson` dataset at `public/ne_10m_ocean.geojson`; the editor reports an error if it is not present.

Data Bank, account sign-in, and publishing are backed by Supabase when configured. Without Supabase settings, the archive displays a configuration error rather than sample data.

## GitHub Pages deployment

The workflow in `.github/workflows/deploy.yml` builds and deploys the site from the `main` branch. Add these repository Actions secrets before deploying:

- `VITE_MAPTILER_KEY` — the MapTiler style URL or API key. Restrict the key to `draw.js-ossy.com`.
- `VITE_SUPABASE_URL` — the Supabase project URL.
- `VITE_SUPABASE_ANON_KEY` — the public anon/publishable key, never a service-role key.

The site includes `public/CNAME` for `draw.js-ossy.com`. At the domain's DNS provider, create a CNAME record named `draw` pointing to `<github-owner>.github.io`. In the repository, enable **Settings → Pages → GitHub Actions**. After DNS propagates and GitHub provisions TLS, enable **Enforce HTTPS**.

