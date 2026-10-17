// Cálculo dos números do painel comercial da Lion. Lê o Supabase no servidor (a chave nunca vai para o navegador).
// Usado pelo servidor local (server.mjs) e pela função do Netlify (netlify/functions/data.mjs).


const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
// Degraus do funil, pelo nome da etapa no FUNIL LION. Um lead conta num degrau se está nele ou em qualquer etapa posterior.
// Etapas laterais (Instagram, SEM RESPOSTA, No Show) não são degraus.
const FUNNEL = ['Em Contato', 'Atendimento', 'MQL', 'Reunião Agendada', 'Reunião Confirmada', 'Reunião Realizada'];
// Degraus extras, depois da reunião, mostrados só no quadro do closer.
const FUNNEL_CLOSER = ['Qualificado', 'Negociação'];
const STAGE = { mql: 'MQL', agendada: 'Reunião Agendada', realizada: 'Reunião Realizada', noShow: 'No Show' };
const SLA_TARGET_MIN = 5;

async function select(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&offset=${offset}&limit=1000`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} ${table}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
// Dia no fuso de Brasília (UTC-3)
export const brDay = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);

const DAY = 86400e3;
const AGING = [[0, 2, 'Até 2 dias'], [3, 7, '3 a 7 dias'], [8, 14, '8 a 14 dias'], [15, Infinity, '15 dias ou mais']];
// Segunda-feira da semana de um dia YYYY-MM-DD
const weekStart = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

// from/to: dias no fuso de Brasília (YYYY-MM-DD), ambos inclusivos.
export async function buildData(from, to) {
  const since = new Date(`${from}T00:00:00-03:00`);
  const until = new Date(`${to}T23:59:59.999-03:00`);
  // Período anterior de mesmo tamanho, para comparação
  const days = Math.round((until - since) / DAY);
  const prevSince = new Date(since.getTime() - days * DAY);
  const prevFrom = brDay(prevSince.toISOString());
  const prevTo = brDay(new Date(since.getTime() - 1).toISOString());
  const [users, stages, reasons, allOpps, allSpend] = await Promise.all([
    select('ghl_users', 'select=*&order=id'),
    select('pipeline_stages', 'select=*&order=position'),
    select('lost_reasons', 'select=*&order=id'),
    select('opportunities', `select=*&created_at=gte.${prevSince.toISOString()}&created_at=lte.${until.toISOString()}&order=created_at.desc,id`),
    select('meta_spend_daily', `select=*&date=gte.${prevFrom}&date=lte.${to}&order=date,campaign_id`),
  ]);
  const opps = allOpps.filter((o) => new Date(o.created_at) >= since);
  const prevOpps = allOpps.filter((o) => new Date(o.created_at) < since);
  const spend = allSpend.filter((r) => r.date >= from);
  const sum = (rows) => rows.reduce((t, r) => t + Number(r.spend), 0);

  const user = Object.fromEntries(users.map((u) => [u.id, u]));
  const stageName = Object.fromEntries(stages.map((s) => [s.id, s.name.trim()]));
  const reasonName = Object.fromEntries(reasons.map((r) => [r.id, r.name]));
  const norm = (v) => v.trim().toLowerCase();
  const pos = (name) => stages.find((s) => norm(s.name) === norm(name))?.position ?? Infinity;
  const funnelPos = [...FUNNEL, ...FUNNEL_CLOSER].map(pos);
  const [pMql, pAg, pReal, pNoShow] = [pos(STAGE.mql), pos(STAGE.agendada), pos(STAGE.realizada), pos(STAGE.noShow)];

  const blank = () => ({ leads: 0, mql: 0, agendadas: 0, realizadas: 0, ganhos: 0, noShow: 0, perdidos: 0, checados: 0, contatados: 0, noSla: 0, minutos: [], funil: funnelPos.map(() => 0) });
  const count = (s, o) => {
    s.leads++;
    funnelPos.forEach((p, i) => { if (o.stage_position >= p) s.funil[i]++; });
    if (o.stage_position >= pMql) s.mql++;
    if (o.stage_position >= pAg) s.agendadas++;
    if (o.stage_position >= pReal) s.realizadas++;
    if (o.stage_position === pNoShow) s.noShow++;
    if (o.status === 'won') s.ganhos++;
    if (o.status === 'lost') s.perdidos++;
    if (o.sla_checked_at) s.checados++;
    if (o.first_contact_at) {
      s.contatados++;
      s.minutos.push(Number(o.sla_business_minutes));
      if (Number(o.sla_business_minutes) <= SLA_TARGET_MIN) s.noSla++;
    }
  };

  const total = blank();
  const previous = blank();
  for (const o of prevOpps) count(previous, o);
  const byUser = {};
  const byDay = {};
  const byWeek = {};
  const lostByReason = {};
  const lostByUser = {};
  const lostByStage = {};
  const queueByStage = {};
  const queueByUser = {};
  const now = Date.now();
  const week = (k) => (byWeek[k] ??= { leads: 0, mql: 0, agendadas: 0, realizadas: 0, investimento: 0 });

  for (const o of opps) {
    const name = user[o.assigned_to]?.name ?? 'Sem responsável';
    const role = user[o.assigned_to]?.role ?? null;
    const u = (byUser[name] ??= { ...blank(), role });
    const day = brDay(o.created_at);
    byDay[day] = (byDay[day] ?? 0) + 1;
    count(total, o);
    count(u, o);
    const w = week(weekStart(day));
    w.leads++;
    if (o.stage_position >= pMql) w.mql++;
    if (o.stage_position >= pAg) w.agendadas++;
    if (o.stage_position >= pReal) w.realizadas++;

    const etapa = stageName[o.stage_id] ?? 'Etapa removida';
    if (o.status === 'lost') {
      const reason = reasonName[o.lost_reason_id] ?? 'Sem motivo informado';
      lostByReason[reason] = (lostByReason[reason] ?? 0) + 1;
      const lu = (lostByUser[name] ??= { role, total: 0, motivos: {} });
      lu.total++;
      lu.motivos[reason] = (lu.motivos[reason] ?? 0) + 1;
      (lostByStage[etapa] ??= { etapa, position: o.stage_position ?? 99, qtd: 0 }).qtd++;
    }
    if (o.status === 'open') {
      // dias parado = desde a última mudança de etapa
      const idle = Math.floor((now - new Date(o.last_stage_change_at ?? o.created_at)) / DAY);
      const bucket = AGING.findIndex(([min, max]) => idle >= min && idle <= max);
      const qs = (queueByStage[etapa] ??= { etapa, position: o.stage_position ?? 99, total: 0, faixas: AGING.map(() => 0) });
      const qu = (queueByUser[name] ??= { nome: name, role, total: 0, faixas: AGING.map(() => 0) });
      for (const q of [qs, qu]) {
        q.total++;
        q.faixas[bucket]++;
      }
    }
  }
  for (const r of spend) week(weekStart(r.date)).investimento += Number(r.spend);

  const byCampaign = {};
  for (const r of spend) {
    const c = (byCampaign[r.campaign_id] ??= { campanha: r.campaign_name, investimento: 0, impressoes: 0, cliques: 0, leads: 0, de: r.date, ate: r.date });
    c.investimento += Number(r.spend);
    c.impressoes += r.impressions ?? 0;
    c.cliques += r.link_clicks ?? 0;
    c.leads += r.leads ?? 0;
    c.ate = r.date;
  }

  // Faixas do tempo de primeiro contato, em minutos de horário comercial
  const faixas = (m) => [m.filter((x) => x <= 5).length, m.filter((x) => x > 5 && x <= 30).length, m.filter((x) => x > 30 && x <= 60).length, m.filter((x) => x > 60).length];
  const finish = (s) => ({
    ...s,
    medianaMin: median(s.minutos),
    mediaMin: s.minutos.length ? s.minutos.reduce((a, b) => a + b, 0) / s.minutos.length : null,
    faixas: faixas(s.minutos),
    minutos: undefined,
  });
  const investimento = sum(spend);
  const synced = opps.reduce((max, o) => (o.synced_at > max ? o.synced_at : max), '');
  return {
    from,
    to,
    slaTargetMin: SLA_TARGET_MIN,
    etapasFunil: FUNNEL,
    etapasCloser: FUNNEL_CLOSER,
    sincronizadoEm: synced || null,
    metaAte: spend.at(-1)?.date ?? null,
    total: finish(total),
    investimento,
    anterior: { from: prevFrom, to: prevTo, total: finish(previous), investimento: sum(allSpend.filter((r) => r.date < from)) },
    porResponsavel: Object.entries(byUser).map(([nome, s]) => ({ nome, ...finish(s) })).sort((a, b) => b.leads - a.leads),
    porDia: Object.entries(byDay).sort().map(([dia, leads]) => ({ dia, leads })),
    porSemana: Object.entries(byWeek).sort().map(([semana, w]) => ({ semana, ...w })),
    // slot = posição fixa do motivo no cadastro do GHL, para a cor não mudar conforme o período (-1 = sem motivo)
    motivosPerda: Object.entries(lostByReason).map(([motivo, qtd]) => ({ motivo, qtd, slot: reasons.findIndex((r) => r.name === motivo) })).sort((a, b) => b.qtd - a.qtd),
    perdidosPorResponsavel: Object.entries(lostByUser).map(([nome, v]) => ({ nome, ...v })).sort((a, b) => b.total - a.total),
    perdidosPorEtapa: Object.values(lostByStage).sort((a, b) => a.position - b.position),
    porCampanha: Object.values(byCampaign).sort((a, b) => b.investimento - a.investimento),
    faixasFila: AGING.map((a) => a[2]),
    filaPorEtapa: Object.values(queueByStage).sort((a, b) => a.position - b.position),
    filaPorResponsavel: Object.values(queueByUser).sort((a, b) => b.total - a.total),
  };
}


// Valida o período pedido (dias YYYY-MM-DD no fuso de Brasília). Sem parâmetros: últimos 30 dias.
export function resolveRange(fromParam, toParam) {
  const today = brDay(new Date().toISOString());
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !isNaN(new Date(v));
  const to = isDay(toParam) ? toParam : today;
  const from = isDay(fromParam) ? fromParam : brDay(new Date(Date.now() - 29 * 86400e3).toISOString());
  if (from > to) throw new Error('A data inicial precisa ser anterior ou igual à data final.');
  return { from, to };
}
