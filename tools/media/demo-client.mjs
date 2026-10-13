// Vite dev server for the demo on :3010 (DEMO_CLIENT_PORT), with /api going to the demo API on :3013 (DEMO_API_PORT)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const API_PORT = Number(process.env.DEMO_API_PORT) || 3013;
const CLIENT_PORT = Number(process.env.DEMO_CLIENT_PORT) || 3010;
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
const server = await createServer({
    root: client,
    configFile: path.join(client, 'vite.config.js'),
    server: { port: CLIENT_PORT, strictPort: true, proxy: { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true } } }
});
await server.listen();
console.log(`demo client on ${CLIENT_PORT}`);
