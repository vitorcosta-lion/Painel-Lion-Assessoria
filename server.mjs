// Painel comercial da Lion, modo local. Lê o Supabase no servidor (a chave nunca vai para o navegador).
// Uso: node --env-file=.env server.mjs   → http://localhost:3000
// Em produção o painel roda no Netlify (ver netlify.toml); este arquivo serve para uso local e para qualquer hospedagem com Node.
// Se DASHBOARD_PASSWORD estiver definida, todo acesso pede essa senha.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runSync } from './sync.mjs';
import { buildData, resolveRange } from './lib/data.mjs';
import { passwordOk, CHALLENGE } from './lib/auth.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1'; // use HOST=0.0.0.0 numa hospedagem com Node
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const ASSETS = {
  '/assets/logo-white.png': 'image/png',
  '/assets/icon-color.png': 'image/png',
  '/assets/Poppins-Regular.ttf': 'font/ttf',
  '/assets/Poppins-Medium.ttf': 'font/ttf',
  '/assets/Poppins-Bold.ttf': 'font/ttf',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (PASSWORD && !passwordOk(req.headers.authorization, PASSWORD)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', ...CHALLENGE });
      return res.end('Acesso restrito.');
    }
    if (url.pathname === '/api/data') {
      const { from, to } = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await buildData(from, to)));
    } else if (url.pathname === '/api/sync' && req.method === 'POST') {
      const result = await runSync({ slaDays: 30 });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } else if (ASSETS[url.pathname]) {
      res.writeHead(200, { 'Content-Type': ASSETS[url.pathname], 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(new URL('./public' + url.pathname, import.meta.url)));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(new URL('./public/index.html', import.meta.url)));
    } else {
      res.writeHead(404).end('Not found');
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`Painel em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${PASSWORD ? ' (com senha)' : ''}`));
