# Supabase Setup

## 1. Create a project

Go to https://supabase.com → New project. Pick any name (e.g. "kwazy-pricing"). Note the **Project URL** and **anon public** key from Settings → API.

## 2. Create the tables

Open the **SQL Editor** in your Supabase dashboard and run this:

```sql
-- Persists the full board state (all rows + settings).
-- Always a single row with id = 'main', upserted on every change.
create table if not exists current_session (
  id          text primary key default 'main',
  updated_at  timestamptz default now(),
  rows        jsonb not null default '[]',
  opex_pct    numeric not null default 6,
  reward_pct  numeric not null default 2
);

-- One record per unique hotel name.
-- Upserted whenever a row has hotel name + TBO price filled in.
create table if not exists hotel_history (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  hotel_name      text not null,
  tbo_gross       numeric not null,
  tbo_base        numeric,
  tbo_gst         numeric,
  tbo_slab_label  text,
  itc_applies     boolean,
  mmt             numeric,
  goibibo         numeric,
  booking         numeric,
  sell_price      numeric,
  markup          numeric,
  net_profit      numeric,
  net_margin_pct  numeric
);
```

## 3. Set environment variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

You can find both values in your Supabase project under **Settings → API**.

## 4. Run locally

```bash
npm run dev
```

The app will now auto-save the board state and hotel history to Supabase as you type.

## How the auto-save works

- **Board state** (`current_session`): every change triggers a 1.5s debounced save of the entire board. On next load, the last state is restored automatically.
- **Hotel history** (`hotel_history`): every row with a hotel name + TBO price is upserted 2s after the last change. If you look up the same hotel again, it updates the existing record rather than creating a duplicate.

## Security note

The anon key is safe to expose in the browser as long as your tables have appropriate Row Level Security (RLS) policies. For personal use with no other users, the simplest approach is to disable RLS on both tables (Supabase does this by default for new tables). If you ever share the app, add RLS policies to lock down access.
