'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000') + '/api';
type Me = { id: string; name: string; role: 'admin' | 'staff' | 'customer'; points: number };
const NEXT: Record<string, string> = { pending: 'preparing', preparing: 'ready', ready: 'completed' };
const pay = (o: any) => (Array.isArray(o.payments) ? o.payments[0] : o.payments);
const money = (n: number) => '₹' + Number(n).toFixed(2);
const run = (p: Promise<unknown>) => p.catch((e) => alert(e.message));
const customers = (order = 'name', asc = true) =>
  sb.from('profiles').select('id,name,points').eq('role', 'customer').order(order, { ascending: asc });

// All writes go through the REST API (roles enforced there); Supabase is used for reads + realtime.
async function api(path: string, method = 'GET', body?: unknown) {
  const { data } = await sb.auth.getSession();
  const r = await fetch(API + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

// Live orders: any change to orders/payments (from mobile, POS or another staff screen) reloads the list.
function useOrders(on: boolean) {
  const [orders, setOrders] = useState<any[]>([]);
  const load = useCallback(async () => {
    const { data } = await sb.from('orders').select('*, order_items(qty, menu_items(name)), payments(status, method)')
      .order('created_at', { ascending: false }).limit(60);
    setOrders(data ?? []);
  }, []);
  useEffect(() => {
    if (!on) return;
    load();
    const ch = sb.channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [on, load]);
  return orders;
}

function Login() {
  const [email, setEmail] = useState('admin@dinepos.test'), [password, setPassword] = useState('password123');
  const [err, setErr] = useState('');
  return (
    <div className="card" style={{ maxWidth: 340, margin: '80px auto' }}>
      <h2>🍽️ DinePOS</h2>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      <button className="go" onClick={async () => setErr((await sb.auth.signInWithPassword({ email, password })).error?.message ?? '')}>
        Sign in
      </button>
      <p style={{ color: 'crimson' }}>{err}</p>
    </div>
  );
}

// ---------- POS: staff create walk-in orders, redeem points, take payment ----------
function POS() {
  const [menu, setMenu] = useState<any[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [custs, setCusts] = useState<any[]>([]);
  const [cust, setCust] = useState(''), [method, setMethod] = useState('cash');
  const [redeem, setRedeem] = useState(0), [paid, setPaid] = useState(true);
  const [msg, setMsg] = useState('');
  const loadCusts = () => customers().then(({ data }) => setCusts(data ?? []));
  useEffect(() => { api('/menu').then(setMenu); loadCusts(); }, []);
  const qty = (id: string) => cart[id] ?? 0;
  const total = menu.reduce((s, m) => s + m.price * qty(m.id), 0);

  const place = async () => {
    const items = Object.entries(cart).filter(([, q]) => q > 0).map(([menu_item_id, qty]) => ({ menu_item_id, qty }));
    if (!items.length) return;
    const o = await api('/orders', 'POST', { items, customer_id: cust || null, method });
    if (cust && redeem > 0) await api('/loyalty/redeem', 'POST', { order_id: o.id, points: redeem });
    const r = paid ? await api(`/orders/${o.id}/payment`, 'PATCH', { status: 'paid', method }) : null;
    setMsg(`Order #${o.id.slice(0, 6)} placed${r ? ` & paid · +${r.points_earned} points` : ' · payment pending'}`);
    setCart({}); setRedeem(0); loadCusts();
  };

  return (
    <div className="grid">
      <div className="card">
        <h3>Menu</h3>
        {menu.filter((m) => m.available).map((m) => (
          <div className="row" key={m.id}>
            <span>{m.name} <small>{money(m.price)}</small></span>
            <span>
              <button onClick={() => setCart({ ...cart, [m.id]: Math.max(0, qty(m.id) - 1) })}>−</button>
              {' '}{qty(m.id)}{' '}
              <button onClick={() => setCart({ ...cart, [m.id]: qty(m.id) + 1 })}>+</button>
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Walk-in order · {money(total)}</h3>
        <select value={cust} onChange={(e) => setCust(e.target.value)}>
          <option value="">Anonymous walk-in</option>
          {custs.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.points} pts)</option>)}
        </select>
        {cust && <input type="number" min={0} value={redeem} onChange={(e) => setRedeem(+e.target.value)} placeholder="Redeem points (1 pt = ₹1)" />}
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {['cash', 'card', 'upi'].map((m) => <option key={m}>{m}</option>)}
        </select>
        <label><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Paid now</label>
        <button className="go" onClick={() => run(place())}>Place order</button>
        <p>{msg}</p>
      </div>
    </div>
  );
}

function Kitchen({ orders }: { orders: any[] }) {
  const active = orders.filter((o) => NEXT[o.status]).reverse();
  return (
    <div className="grid">
      {active.map((o) => (
        <div className="card" key={o.id}>
          <b>#{o.id.slice(0, 6)}</b> · {o.source} · {o.status}
          <ul>{o.order_items.map((i: any, k: number) => <li key={k}>{i.qty}× {i.menu_items?.name}</li>)}</ul>
          <button className="go" onClick={() => run(api(`/orders/${o.id}/status`, 'PATCH', { status: NEXT[o.status] }))}>
            Mark {NEXT[o.status]}
          </button>
        </div>
      ))}
      {!active.length && <p>No active orders 🎉</p>}
    </div>
  );
}

function Orders({ orders, admin }: { orders: any[]; admin: boolean }) {
  return (
    <table className="card">
      <thead><tr><th>#</th><th>Source</th><th>Total</th><th>Status</th><th>Payment</th><th></th></tr></thead>
      <tbody>
        {orders.map((o) => {
          const p = pay(o), open = p?.status === 'pending' && o.status !== 'cancelled';
          const call = (path: string, body?: unknown, m = 'POST') => run(api(`/orders/${o.id}/${path}`, m, body));
          return (
            <tr key={o.id}>
              <td>{o.id.slice(0, 6)}</td><td>{o.source}</td><td>{money(o.total)}</td><td>{o.status}</td><td>{p?.status}</td>
              <td>
                {open && <button onClick={() => call('payment', { status: 'paid' }, 'PATCH')}>Mark paid</button>}
                {open && o.status !== 'completed' && <button onClick={() => call('cancel')}>Cancel</button>}
                {admin && p?.status === 'paid' && <button onClick={() => confirm('Refund this order?') && call('refund')}>Refund</button>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Loyalty() {
  const [custs, setCusts] = useState<any[]>([]), [sel, setSel] = useState(''), [h, setH] = useState<any>(null);
  useEffect(() => { customers('points', false).then(({ data }) => setCusts(data ?? [])); }, []);
  useEffect(() => { if (sel) api(`/loyalty/${sel}/history`).then(setH); }, [sel]);
  const day = (d: string) => new Date(d).toLocaleDateString();
  return (
    <div className="grid">
      <div className="card">
        <h3>Customers</h3>
        {custs.map((c) => (
          <div className="row" key={c.id}>
            <button className="link" onClick={() => setSel(c.id)}>{c.name}</button><b>{c.points} pts</b>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Purchase history</h3>
        {!h && <p>Select a customer</p>}
        {h?.purchases.slice(0, 12).map((p: any) => (
          <div className="row" key={p.id}><span>{day(p.created_at)} · {p.status}</span><span>{money(p.total)}</span></div>
        ))}
      </div>
      <div className="card">
        <h3>Points ledger</h3>
        {h?.ledger.slice(0, 12).map((l: any) => (
          <div className="row" key={l.id}><span>{day(l.created_at)} · {l.type}</span><b>{l.points > 0 ? '+' : ''}{l.points}</b></div>
        ))}
      </div>
    </div>
  );
}

function Menu() {
  const [items, setItems] = useState<any[]>([]), [f, setF] = useState({ name: '', category: 'Main', price: '' });
  const load = () => api('/menu').then(setItems);
  useEffect(() => { load(); }, []);
  const save = (p: Promise<unknown>) => run(p.then(load));
  const put = (id: string, body: object) => save(api(`/menu/${id}`, 'PUT', body));
  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="row">
        <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        <input placeholder="Price" type="number" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <button className="go" onClick={() => save(api('/menu', 'POST', { ...f, price: +f.price }).then(() => setF({ ...f, name: '', price: '' })))}>Add</button>
      </div>
      {items.map((m) => (
        <div className="row" key={m.id}>
          <span>{m.name} · {m.category} · {money(m.price)} {!m.available && '(hidden)'}</span>
          <span>
            <button onClick={() => { const p = prompt('New price', m.price); if (p) put(m.id, { price: +p }); }}>Price</button>
            <button onClick={() => put(m.id, { available: !m.available })}>{m.available ? 'Hide' : 'Show'}</button>
            <button onClick={() => confirm('Delete item?') && save(api(`/menu/${m.id}`, 'DELETE'))}>Delete</button>
          </span>
        </div>
      ))}
    </div>
  );
}

function Reports() {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('/reports/summary').then(setR); }, []);
  if (!r) return <p className="card">Loading…</p>;
  const cards = [['Orders', r.orders], ['Revenue', money(r.revenue)], ['Customers', r.customers], ...Object.entries(r.byStatus)];
  return (
    <div className="grid">
      {cards.map(([k, v]) => <div className="card" key={String(k)}><small>{String(k)}</small><h2>{String(v)}</h2></div>)}
    </div>
  );
}

export default function Page() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null), [tab, setTab] = useState('POS');
  const staff = !!me && me.role !== 'customer';
  const orders = useOrders(staff);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
    const { data } = sb.auth.onAuthStateChange((_, s) => setToken(s?.access_token ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (token) api('/me').then(setMe).catch(() => setMe(null)); else setMe(null); }, [token]);
  if (token === undefined) return null;
  const tabs = ['POS', 'Kitchen', 'Orders', 'Loyalty', ...(me?.role === 'admin' ? ['Menu', 'Reports'] : [])];
  return (
    <>
      <style>{css}</style>
      {!token ? <Login /> : !me ? <p className="card">Loading…</p> : !staff ? (
        <div className="card" style={{ maxWidth: 360, margin: '80px auto' }}>Customers order through the mobile app. <button onClick={() => sb.auth.signOut()}>Sign out</button></div>
      ) : (
        <>
          <div className="bar">
            <b>🍽️ DinePOS</b>
            {tabs.map((t) => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
            <span className="sp" />
            <small>● live · {me.name || me.role} ({me.role})</small>
            <button onClick={() => sb.auth.signOut()}>Sign out</button>
          </div>
          {tab === 'POS' && <POS />}
          {tab === 'Kitchen' && <Kitchen orders={orders} />}
          {tab === 'Orders' && <Orders orders={orders} admin={me.role === 'admin'} />}
          {tab === 'Loyalty' && <Loyalty />}
          {tab === 'Menu' && <Menu />}
          {tab === 'Reports' && <Reports />}
        </>
      )}
    </>
  );
}

const css = `body{margin:0;font-family:system-ui,sans-serif;background:#f5f5f2;color:#222}.sp{flex:1}
.bar{display:flex;gap:6px;align-items:center;padding:10px 16px;background:#1f2937;color:#fff;flex-wrap:wrap}
button{padding:6px 12px;border:0;border-radius:6px;background:#e5e7eb;cursor:pointer;margin:2px}button.link{background:none;color:#2563eb;padding:0}
button.on,button.go{background:#f59e0b;font-weight:600}.card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 3px #0002}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:16px}input[type=checkbox]{width:auto}
input,select{padding:7px;margin:3px 0;width:100%;box-sizing:border-box}.row input{flex:1;width:auto}td,th{padding:6px;text-align:left}
.row{display:flex;gap:6px;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #eee}
table{width:calc(100% - 32px);margin:16px;border-collapse:collapse}`;