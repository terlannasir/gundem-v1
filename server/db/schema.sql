-- Gündəm backend schema (PostgreSQL 14+ / Supabase)
create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  google_sub    text unique not null,
  email         text not null,
  name          text,
  avatar_url    text,
  plan          text not null default 'free' check (plan in ('free','premium')),
  plan_until    timestamptz,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Google refresh token, AES-256-GCM encrypted (see src/crypto.js)
create table if not exists google_tokens (
  user_id        uuid primary key references users(id) on delete cascade,
  refresh_token  text not null,
  scopes         text not null,
  updated_at     timestamptz not null default now()
);

-- Everything the web app kept in the artifact store: profile prefs, sections, rules, tasks, doc pins
create table if not exists user_state (
  user_id    uuid not null references users(id) on delete cascade,
  key        text not null check (key in ('profile','settings','tasks','docs','aicat','brief')),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Monthly AI usage for quotas and cost tracking
create table if not exists ai_usage (
  user_id     uuid not null references users(id) on delete cascade,
  month       text not null,               -- 'YYYY-MM'
  chat_msgs   int  not null default 0,
  briefs      int  not null default 0,
  tokens_in   bigint not null default 0,
  tokens_out  bigint not null default 0,
  cost_usd    numeric(10,4) not null default 0,
  primary key (user_id, month)
);

-- One-time codes for the mobile OAuth hand-off (app deep link → POST /auth/exchange)
create table if not exists login_codes (
  code        text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null
);

create index if not exists login_codes_exp on login_codes(expires_at);

-- PKCE: the login code is bound to the device/tab that started the login (sha256 of its secret verifier)
alter table login_codes add column if not exists challenge text;
-- JWT revocation: bumping token_version logs out every device of the user
alter table users add column if not exists token_version int not null default 0;
delete from login_codes where expires_at < now();
