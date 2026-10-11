// Vite dev server for the demo on :3010, with /api going to the demo API on :3013
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
const server = await createServer({
    root: client,
    configFile: path.join(client, 'vite.config.js'),
    server: { port: 3010, strictPort: true, proxy: { '/api': { target: 'http://localhost:3013', changeOrigin: true } } }
});
await server.listen();
console.log('demo client on 3010');
