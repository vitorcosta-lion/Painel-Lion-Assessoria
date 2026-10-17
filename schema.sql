-- Lion Comercial dashboard: tabelas alimentadas pelo sync.mjs a partir do GHL e do Meta.
-- RLS ligado sem policies: só a service_role (usada pelo sync e pelo painel no servidor) lê e grava.

create table if not exists ghl_users (
  id text primary key,
  name text not null,
  role text -- 'sdr' | 'closer' | null
);

create table if not exists pipeline_stages (
  id text primary key,
  name text not null,
  position int not null
);

create table if not exists lost_reasons (
  id text primary key,
  name text not null
);

create table if not exists opportunities (
  id text primary key,
  name text,
  contact_id text,
  assigned_to text,
  stage_id text,
  stage_position int,
  status text, -- open | won | lost | abandoned
  lost_reason_id text,
  source text,
  created_at timestamptz not null,
  updated_at timestamptz,
  last_stage_change_at timestamptz,
  last_status_change_at timestamptz,
  -- SLA: primeira mensagem/ligação manual de saída depois da criação do lead
  sla_checked_at timestamptz,
  first_contact_at timestamptz,
  first_contact_user text,
  sla_business_minutes numeric,
  synced_at timestamptz not null default now()
);
create index if not exists opportunities_created_at_idx on opportunities (created_at);
create index if not exists opportunities_assigned_to_idx on opportunities (assigned_to);

-- Histórico de mudança de etapa, registrado a cada sync (a API do GHL só expõe a etapa atual).
create table if not exists stage_events (
  id bigint generated always as identity primary key,
  opportunity_id text not null,
  from_stage_id text,
  to_stage_id text not null,
  changed_at timestamptz not null
);
create index if not exists stage_events_opportunity_idx on stage_events (opportunity_id);

create table if not exists meta_spend_daily (
  date date not null,
  campaign_id text not null,
  campaign_name text,
  spend numeric not null,
  impressions integer,
  link_clicks integer,
  leads integer, -- leads contados pelo Meta
  primary key (date, campaign_id)
);

alter table ghl_users enable row level security;
alter table pipeline_stages enable row level security;
alter table lost_reasons enable row level security;
alter table opportunities enable row level security;
alter table stage_events enable row level security;
alter table meta_spend_daily enable row level security;
