// Sincroniza o FUNIL LION do GHL com o Supabase.
// Uso: node --env-file=.env sync.mjs [--dry] [--sla-days=30]
//   --dry  não grava no Supabase; só imprime o resumo das métricas.

import { pathToFileURL } from 'node:url';

const GHL = 'https://services.leadconnectorhq.com';
const PIPELINE_ID = '5kQPLKtOBv4FmCqsClPK'; // FUNIL LION
const STAGE = { mql: 'MQL', agendada: 'Reunião Agendada', realizada: 'Reunião Realizada', noShow: 'No Show' };
const ROLES = { 'Maysa Santos': 'sdr', 'Jessie Salas': 'sdr', 'Vinicius Ribeiro': 'sdr', 'Pedro Souza': 'closer' };
// Horário comercial: seg a sex, 9h–19h, horário de Brasília (UTC-3, sem horário de verão).
const BUSINESS = { startHour: 9, endHour: 19, utcOffsetHours: -3 };
const SLA_TARGET_MIN = 5;

let DRY = false;
let SLA_DAYS = 30;

const { GHL_PRIVATE_TOKEN, GHL_LOCATION_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID) throw new Error('Faltam GHL_PRIVATE_TOKEN / GHL_LOCATION_ID no .env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghl(path, version = '2021-07-28') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GHL + path, {
      headers: { Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`, Version: version, Accept: 'application/json' },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`GHL ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

async function supabase(method, path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
  return method === 'GET' ? res.json() : null;
}

async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    await supabase('POST', `${table}?on_conflict=id`, rows.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
  }
}

async function selectAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await supabase('GET', `${table}?select=${columns}&order=id&offset=${from}&limit=1000`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Minutos de horário comercial entre duas datas.
function businessMinutes(from, to) {
  const off = BUSINESS.utcOffsetHours * 3600e3;
  let total = 0;
  // percorre dia a dia no fuso local (deslocando o relógio UTC)
  const start = new Date(from.getTime() + off);
  const end = new Date(to.getTime() + off);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (; day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const open = day.getTime() + BUSINESS.startHour * 3600e3;
    const close = day.getTime() + BUSINESS.endHour * 3600e3;
    const a = Math.max(open, start.getTime());
    const b = Math.min(close, end.getTime());
    if (b > a) total += (b - a) / 60e3;
  }
  return Math.round(total * 10) / 10;
}

const MANUAL_TYPES = /^TYPE_(SMS|CUSTOM_SMS|WHATSAPP|CALL|CUSTOM_CALL|EMAIL|CUSTOM_EMAIL|FACEBOOK|INSTAGRAM|GMB|LIVE_CHAT)$/;
const AUTOMATED_SOURCES = new Set(['workflow', 'campaign', 'bulk_actions']);

// Primeira mensagem/ligação manual de saída para o contato depois de `since`.
async function firstManualContact(contactId, since) {
  const { conversations = [] } = await ghl(`/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`, '2021-04-15');
  let first = null;
  for (const conv of conversations) {
    let lastMessageId;
    for (let page = 0; page < 20; page++) {
      const { messages } = await ghl(`/conversations/${conv.id}/messages?limit=100${lastMessageId ? `&lastMessageId=${lastMessageId}` : ''}`, '2021-04-15');
      for (const m of messages.messages) {
        // Sem userId = disparo automático via API (chega segundos após o lead entrar), não é contato do SDR.
        if (m.direction !== 'outbound' || !m.userId || !MANUAL_TYPES.test(m.messageType) || AUTOMATED_SOURCES.has(m.source)) continue;
        const at = new Date(m.dateAdded);
        if (at >= since && (!first || at < first.at)) first = { at, userId: m.userId ?? null };
      }
      if (!messages.nextPage || !messages.messages.length) break;
      lastMessageId = messages.lastMessageId;
    }
  }
  return first;
}

async function main() {
  console.log(`Sync FUNIL LION ${DRY ? '(dry-run, nada é gravado)' : ''}`);

  const [{ pipelines }, { users }, { lostReasons }] = await Promise.all([
    ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`),
    ghl(`/users/?locationId=${GHL_LOCATION_ID}`),
    ghl(`/opportunities/lost-reason?locationId=${GHL_LOCATION_ID}`),
  ]);
  const stages = pipelines.find((p) => p.id === PIPELINE_ID).stages.map((s) => ({ id: s.id, name: s.name.trim(), position: s.position }));
  const stagePos = Object.fromEntries(stages.map((s) => [s.id, s.position]));
  const posOf = (name) => stages.find((s) => s.name.toLowerCase() === name.toLowerCase())?.position ?? Infinity;
  const userRows = users.map((u) => ({ id: u.id, name: u.name, role: ROLES[u.name] ?? null }));
  const userName = Object.fromEntries(userRows.map((u) => [u.id, u.name]));
  const reasonRows = lostReasons.map((r) => ({ id: r._id, name: r.name }));
  const reasonName = Object.fromEntries(reasonRows.map((r) => [r.id, r.name]));

  // Oportunidades (paginação por cursor)
  const opps = [];
  let cursor = '';
  for (;;) {
    const { opportunities, meta } = await ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${PIPELINE_ID}&limit=100${cursor}`);
    opps.push(...opportunities);
    if (!meta.startAfterId || opportunities.length < 100) break;
    cursor = `&startAfter=${meta.startAfter}&startAfterId=${meta.startAfterId}`;
  }
  console.log(`Oportunidades lidas: ${opps.length}`);

  const now = new Date();
  const rows = opps.map((o) => ({
    id: o.id,
    name: o.name,
    contact_id: o.contactId,
    assigned_to: o.assignedTo ?? null,
    stage_id: o.pipelineStageId,
    stage_position: stagePos[o.pipelineStageId] ?? null,
    status: o.status,
    lost_reason_id: o.lostReasonId ?? null,
    source: o.source ?? null,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    last_stage_change_at: o.lastStageChangeAt ?? null,
    last_status_change_at: o.lastStatusChangeAt ?? null,
    synced_at: now.toISOString(),
  }));

  // Estado anterior, para registrar mudanças de etapa e não rechecar SLA já resolvido.
  const previous = DRY ? [] : await selectAll('opportunities', 'id,stage_id,first_contact_at,first_contact_user,sla_business_minutes,sla_checked_at');
  const prevById = Object.fromEntries(previous.map((p) => [p.id, p]));

  // SLA dos leads recentes
  const slaSince = new Date(now - SLA_DAYS * 86400e3);
  const slaRows = rows.filter((r) => new Date(r.created_at) >= slaSince && !prevById[r.id]?.first_contact_at);
  console.log(`Checando primeiro contato de ${slaRows.length} leads (últimos ${SLA_DAYS} dias)...`);
  let done = 0;
  await pool(slaRows, 4, async (r) => {
    const created = new Date(r.created_at);
    const first = r.contact_id ? await firstManualContact(r.contact_id, created) : null;
    r.sla_checked_at = now.toISOString();
    r.first_contact_at = first?.at.toISOString() ?? null;
    r.first_contact_user = first?.userId ?? null;
    r.sla_business_minutes = first ? businessMinutes(created, first.at) : null;
    if (++done % 100 === 0) console.log(`  ${done}/${slaRows.length}`);
  });
  // PostgREST exige as mesmas chaves em todas as linhas do lote.
  for (const r of rows) {
    if (r.sla_checked_at !== undefined) continue;
    const p = prevById[r.id];
    r.sla_checked_at = p?.sla_checked_at ?? null;
    r.first_contact_at = p?.first_contact_at ?? null;
    r.first_contact_user = p?.first_contact_user ?? null;
    r.sla_business_minutes = p?.sla_business_minutes ?? null;
  }

  if (!DRY) {
    const events = rows
      .filter((r) => prevById[r.id] && prevById[r.id].stage_id !== r.stage_id)
      .map((r) => ({ opportunity_id: r.id, from_stage_id: prevById[r.id].stage_id, to_stage_id: r.stage_id, changed_at: r.last_stage_change_at ?? now.toISOString() }));
    await upsert('ghl_users', userRows);
    await upsert('pipeline_stages', stages);
    // etapas removidas do funil no GHL saem da tabela
    await supabase('DELETE', `pipeline_stages?id=not.in.(${stages.map((s) => `"${s.id}"`).join(',')})`);
    await upsert('lost_reasons', reasonRows);
    await upsert('opportunities', rows);
    if (events.length) await supabase('POST', 'stage_events', events, 'return=minimal');
    console.log(`Gravado no Supabase: ${rows.length} oportunidades, ${events.length} mudanças de etapa.`);
  }

  // Resumo do período de SLA_DAYS
  const recent = rows.filter((r) => new Date(r.created_at) >= slaSince);
  const [pMql, pAg, pReal, pNoShow] = [posOf(STAGE.mql), posOf(STAGE.agendada), posOf(STAGE.realizada), posOf(STAGE.noShow)];
  const by = {};
  for (const r of recent) {
    const k = userName[r.assigned_to] ?? '(sem responsável)';
    const s = (by[k] ??= { leads: 0, mql: 0, agendadas: 0, realizadas: 0, noShow: 0, perdidos: 0, contatados: 0, noSla: 0, minutos: [] });
    s.leads++;
    if (r.stage_position >= pMql) s.mql++;
    if (r.stage_position >= pAg) s.agendadas++;
    if (r.stage_position >= pReal) s.realizadas++;
    if (r.stage_position === pNoShow) s.noShow++;
    if (r.status === 'lost') s.perdidos++;
    if (r.first_contact_at) {
      s.contatados++;
      s.minutos.push(r.sla_business_minutes);
      if (r.sla_business_minutes <= SLA_TARGET_MIN) s.noSla++;
    }
  }
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  console.log(`\nÚltimos ${SLA_DAYS} dias — ${recent.length} leads`);
  console.table(Object.fromEntries(Object.entries(by).map(([k, s]) => [k, {
    leads: s.leads, mql: s.mql, agendadas: s.agendadas, realizadas: s.realizadas, noShow: s.noShow, perdidos: s.perdidos,
    contatados: s.contatados, 'dentro SLA': s.noSla, 'mediana min': median(s.minutos),
  }])));
  const lost = recent.filter((r) => r.status === 'lost');
  const reasons = {};
  for (const r of lost) reasons[reasonName[r.lost_reason_id] ?? '(sem motivo)'] = (reasons[reasonName[r.lost_reason_id] ?? '(sem motivo)'] ?? 0) + 1;
  console.log('Motivos de perda:');
  console.table(reasons);
  return { oportunidades: rows.length, slaChecados: slaRows.length };
}

let running = null;
// Uma sincronização por vez; chamadas simultâneas aguardam a que já está rodando.
export function runSync({ dry = false, slaDays = 30 } = {}) {
  running ??= (async () => {
    DRY = dry;
    SLA_DAYS = slaDays;
    try {
      return await main();
    } finally {
      running = null;
    }
  })();
  return running;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  runSync({ dry: !!args.dry, slaDays: Number(args['sla-days'] ?? 30) }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
