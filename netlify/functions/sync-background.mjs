// POST /api/sync → sincroniza GHL e Meta com o Supabase (ver netlify.toml).
// Função em segundo plano: o Netlify responde 202 na hora e deixa esta rodar até 15 minutos.
// Trava de segurança: se já sincronizou há menos de 5 minutos, ignora (evita gastar o limite de consultas do GHL com cliques repetidos).
import { runSync } from '../../sync.mjs';
import { accessOk } from '../../lib/auth.mjs';

const COOLDOWN_MS = 5 * 60e3;

async function lastSyncAt() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?select=synced_at&order=synced_at.desc&limit=1`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  return res.ok ? ((await res.json())[0]?.synced_at ?? null) : null;
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST' || !accessOk(event.headers.authorization, process.env.DASHBOARD_PASSWORD)) return;
  try {
    const last = await lastSyncAt();
    if (last && Date.now() - new Date(last) < COOLDOWN_MS) return console.log('Sync ignorado: o último foi há menos de 5 minutos.');
    console.log('Sync concluído:', JSON.stringify(await runSync({ slaDays: 30 })));
  } catch (e) {
    console.error('Sync falhou:', e.message);
  }
};
