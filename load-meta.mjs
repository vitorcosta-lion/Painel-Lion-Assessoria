// Grava no Supabase o investimento diário por campanha exportado do Meta.
// Uso: node --env-file=.env load-meta.mjs <arquivo.json>
// O arquivo é o resultado diário por campanha: { ad_entities: [{ date_start, id, name, amount_spent: { value }, impressions, link_click, lead }] }

import { readFileSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const entities = typeof raw.ad_entities === 'string' ? JSON.parse(raw.ad_entities) : raw.ad_entities;

const rows = entities
  .filter((e) => e.amount_spent?.value)
  .map((e) => ({
    date: e.date_start,
    campaign_id: e.id,
    campaign_name: e.name,
    spend: Number(e.amount_spent.value),
    impressions: Number(e.impressions ?? 0),
    link_clicks: Number(e.link_click ?? 0),
    leads: Number(e.lead ?? 0),
  }));

const res = await fetch(`${SUPABASE_URL}/rest/v1/meta_spend_daily?on_conflict=date,campaign_id`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows),
});
if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
const total = rows.reduce((s, r) => s + r.spend, 0);
console.log(`${rows.length} linhas gravadas, de ${rows.at(0)?.date} a ${rows.at(-1)?.date}. Total R$ ${total.toFixed(2)}`);
