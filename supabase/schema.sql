-- SyllabAI database schema. Paste this whole file into the Supabase SQL Editor and Run.
-- Safe to re-run: it drops nothing, only creates what's missing.

create extension if not exists pgcrypto;

-- Upgrades for databases created before these columns existed (safe to re-run).
alter table if exists public.courses add column if not exists description text not null default '';
alter table if exists public.courses add column if not exists facts_override jsonb not null default '{}';
alter table if exists public.courses add column if not exists grades jsonb not null default '{}';

-- ---------------------------------------------------------------- courses
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  title text not null default '',
  term text not null default '',
  instructor text not null default '',
  color text not null default '#4f46e5',
  description text not null default '',
  facts_override jsonb not null default '{}',
  grades jsonb not null default '{}',
  allowances jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- documents
-- text holds the extracted syllabus text (what the AI reads); chunks is the
-- pre-chunked jsonb used for retrieval; file_path points at the ORIGINAL
-- uploaded pdf/docx in the private "documents" storage bucket for previews.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  filename text not null,
  kind text not null,
  text text not null,
  chunks jsonb not null default '[]',
  facts jsonb not null default '{}',
  facts_mode text not null default 'heuristic',
  file_path text not null default '',
  uploaded_at timestamptz not null default now()
);
create index if not exists idx_documents_user on public.documents(user_id);

-- ---------------------------------------------------------------- notes
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- events
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid references public.courses(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  title text not null,
  date date not null,
  time text not null default '',
  kind text not null default 'other',
  source text not null default 'manual',
  details text not null default ''
);
create index if not exists idx_events_user_date on public.events(user_id, date);

-- ---------------------------------------------------------------- chat sessions & chats
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  marker text not null default '',
  title text not null default '',
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  course_id uuid,
  question text not null,
  answer jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_chats_session on public.chats(session_id);

-- ---------------------------------------------------------------- AI usage (daily limits)
-- Clients may READ their own row; only the edge function (service role) writes it.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------- shared courses
-- Public snapshots for one-click imports: any signed-in student can search
-- them and copy one into their own account. Text-only (no original files).
create table if not exists public.shared_courses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  title text not null default '',
  term text not null default '',
  instructor text not null default '',
  color text not null default '#4f46e5',
  description text not null default '',
  allowances jsonb not null default '[]',
  docs jsonb not null default '[]',
  events jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists idx_shared_code on public.shared_courses(code);

-- ---------------------------------------------------------------- calendar feeds
-- Saved Canvas/Moodle calendar-feed URLs, refreshed through the edge function.
create table if not exists public.feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- digest opt-out
-- Weekly email digest preference (default on; row only written when toggled).
create table if not exists public.digest_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true
);

-- ---------------------------------------------------------------- feedback
-- Users drop ideas here; read them in Table Editor -> feedback. The app also
-- opens the sender's mail app addressed to the owner.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text not null default '',
  text text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row level security
alter table public.courses enable row level security;
alter table public.documents enable row level security;
alter table public.notes enable row level security;
alter table public.events enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chats enable row level security;
alter table public.ai_usage enable row level security;
alter table public.feedback enable row level security;
alter table public.shared_courses enable row level security;
alter table public.feeds enable row level security;
alter table public.digest_prefs enable row level security;

do $$ begin
  create policy "shared readable" on public.shared_courses
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "shared write own" on public.shared_courses
    for insert to authenticated with check (auth.uid() = owner_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "shared update own" on public.shared_courses
    for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "shared delete own" on public.shared_courses
    for delete to authenticated using (auth.uid() = owner_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own feeds" on public.feeds
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own digest pref" on public.digest_prefs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own courses" on public.courses
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own documents" on public.documents
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own notes" on public.notes
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own events" on public.events
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own chat_sessions" on public.chat_sessions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own chats" on public.chats
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "read own usage" on public.ai_usage
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert feedback" on public.feedback
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- storage: original files
-- Private bucket for the uploaded PDFs/Word docs, one folder per user.
insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
on conflict (id) do nothing;

do $$ begin
  create policy "own files select" on storage.objects
    for select using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own files insert" on storage.objects
    for insert with check (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own files delete" on storage.objects
    for delete using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);
exception when duplicate_object then null; end $$;
