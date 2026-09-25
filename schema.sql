-- DinePOS schema: paste into Supabase SQL Editor and run once.

-- ========== TABLES ==========
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'customer' check (role in ('admin','staff','customer')),
  points int not null default 0 check (points >= 0),
  created_at timestamptz not null default now()
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Main',
  price numeric(10,2) not null check (price >= 0),
  available boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.profiles(id),
  source text not null default 'mobile' check (source in ('mobile','pos')),
  status text not null default 'pending'
    check (status in ('pending','preparing','ready','completed','cancelled')),
  total numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id),
  qty int not null check (qty > 0),
  price numeric(10,2) not null
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  amount numeric(10,2) not null,
  method text not null default 'cash' check (method in ('cash','card','upi')),
  status text not null default 'pending'
    check (status in ('pending','paid','failed','refunded')),
  updated_at timestamptz not null default now()
);

create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  order_id uuid references public.orders(id),
  points int not null,
  type text not null check (type in ('earn','redeem')),
  created_at timestamptz not null default now()
);

create index on public.orders (customer_id, created_at desc);
create index on public.order_items (order_id);
create index on public.loyalty_ledger (customer_id, created_at desc);

-- ========== AUTO-CREATE PROFILE ON SIGNUP ==========
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ========== ROLE-BASED ACCESS (RLS) ==========
-- Reads are guarded here. All writes go through the Node API (service key).
create function public.is_staff() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('admin','staff'))
$$;

alter table public.profiles enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.loyalty_ledger enable row level security;

create policy "own or staff" on public.profiles for select using (id = auth.uid() or is_staff());
create policy "menu readable" on public.menu_items for select to authenticated using (true);
create policy "own or staff" on public.orders for select using (customer_id = auth.uid() or is_staff());
create policy "own or staff" on public.order_items for select using (
  exists (select 1 from orders o where o.id = order_id and (o.customer_id = auth.uid() or is_staff())));
create policy "own or staff" on public.payments for select using (
  exists (select 1 from orders o where o.id = order_id and (o.customer_id = auth.uid() or is_staff())));
create policy "own or staff" on public.loyalty_ledger for select using (customer_id = auth.uid() or is_staff());

-- ========== REALTIME (order sync across all 3 surfaces) ==========
alter publication supabase_realtime add table public.orders, public.payments, public.menu_items;