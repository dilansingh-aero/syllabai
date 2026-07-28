-- MySyllabi database schema. Paste this whole file into the Supabase SQL Editor and Run.
-- Safe to re-run: it drops nothing, only creates what's missing.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- courses
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  title text not null default '',
  term text not null default '',
  instructor text not null default '',
  color text not null default '#4f46e5',
  allowances jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- documents
-- text holds the full extracted syllabus; chunks is the pre-chunked jsonb array
-- [{section, text}] used for retrieval so the client never re-parses.
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
-- Clients may READ their own row; only the edge function (service role) writes it,
-- so nobody can reset their own counter.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------- row level security
alter table public.courses enable row level security;
alter table public.documents enable row level security;
alter table public.notes enable row level security;
alter table public.events enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chats enable row level security;
alter table public.ai_usage enable row level security;

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
