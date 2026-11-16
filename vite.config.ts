import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-server-only endpoints for dev-mode export: write stops.json / thumbs straight into
 * public/. Only exists under `npm run dev` (never in the build), and only accepts these paths.
 */
function devSave(): Plugin {
  const allowed = /^(stops\.json|thumbs\/stop-\d+\.webp|og-image\.jpg)$/; // og-image: the link-preview image
  // The dev server may be opened to the local network (to try the site on a phone); only this
  // computer may write files.
  const fromThisMachine = (req: { socket: { remoteAddress?: string } }) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  return {
    name: 'tour-dev-save',
    apply: 'serve',
    configureServer(server) {
      const publicDir = server.config.publicDir;
      server.middlewares.use('/__dev/save', async (req, res) => {
        try {
          const path = new URL(req.url ?? '', 'http://x').searchParams.get('path') ?? '';
          if (req.method !== 'POST' || !allowed.test(path) || !fromThisMachine(req)) {
            res.statusCode = 400;
            return res.end('bad request');
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const file = join(publicDir, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, Buffer.concat(chunks));
          res.end('ok');
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
      // Body: JSON list of thumbnail names to keep; other stop-N.webp files are deleted.
      server.middlewares.use('/__dev/prune-thumbs', async (req, res) => {
        try {
          if (req.method !== 'POST' || !fromThisMachine(req)) {
            res.statusCode = 400;
            return res.end('bad request');
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const keep = new Set<string>(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const dir = join(publicDir, 'thumbs');
          const names = await readdir(dir).catch(() => [] as string[]);
          const removed = [];
          for (const n of names) {
            if (/^stop-\d+\.webp$/.test(n) && !keep.has(n)) {
              await unlink(join(dir, n));
              removed.push(n);
            }
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ removed }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  base: '/tucson-military-vehicles/',
  plugins: [devSave()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
