// GET /api/data?from=YYYY-MM-DD&to=YYYY-MM-DD → números do painel (ver netlify.toml).
import { buildData, resolveRange } from '../../lib/data.mjs';
import { accessOk, CHALLENGE } from '../../lib/auth.mjs';

const reply = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  if (!accessOk(event.headers.authorization, process.env.DASHBOARD_PASSWORD)) return reply(401, { error: 'Acesso restrito.' }, CHALLENGE);
  try {
    const q = event.queryStringParameters ?? {};
    const { from, to } = resolveRange(q.from, q.to);
    return reply(200, await buildData(from, to));
  } catch (e) {
    console.error(e);
    return reply(500, { error: e.message });
  }
};
