import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

type Role = 'admin' | 'staff' | 'customer';
type Profile = { id: string; name: string; role: Role; points: number };

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const app = express();
app.use(cors(), express.json());

// ---------- helpers ----------
class HttpError extends Error {
  constructor(public code: number, msg: string) { super(msg); }
}
const h = (fn: (req: Request<any>, res: Response) => Promise<unknown>) => (req: Request<any>, res: Response) =>
  fn(req, res).catch((e) => res.status(e.code ?? 500).json({ error: e.message }));
const must = (r: { data: any; error: any }) => {
  if (r.error) throw new HttpError(r.error.code === 'PGRST116' ? 404 : 400, r.error.message);
  return r.data;
};
const me = (res: Response): Profile => res.locals.user;
const money = (n: number) => Math.round(n * 100) / 100;
const earned = (total: number) => Math.floor(total / 10); // 1 point per 10 spent; 1 point = 1 off
const now = () => new Date().toISOString();

// ---------- auth + role-based access ----------
const auth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
  const { data } = await db.auth.getUser(token);
  if (!data.user) return res.status(401).json({ error: 'Unauthorized' });
  const { data: p } = await db.from('profiles').select('id,name,role,points').eq('id', data.user.id).single();
  if (!p) return res.status(401).json({ error: 'No profile' });
  res.locals.user = p;
  next();
};
const allow = (...roles: Role[]) => (_: Request, res: Response, next: NextFunction) =>
  roles.includes(me(res).role) ? next() : res.status(403).json({ error: 'Forbidden' });
const staff = allow('staff', 'admin');
const admin = allow('admin');

// ---------- domain helpers ----------
const getOrder = async (id: string, u: Profile) => {
  const o = must(await db.from('orders').select('*, order_items(*, menu_items(name)), payments(*)').eq('id', id).single());
  if (u.role === 'customer' && o.customer_id !== u.id) throw new HttpError(403, 'Forbidden');
  return { ...o, payments: Array.isArray(o.payments) ? o.payments[0] : o.payments };
};
// Signed points: earn = +, redeem = -, refund reversal = negative earn.
const adjust = async (cid: string, oid: string | null, pts: number, type: 'earn' | 'redeem') => {
  if (!pts) return;
  const p = must(await db.from('profiles').select('points').eq('id', cid).single());
  must(await db.from('profiles').update({ points: Math.max(0, p.points + pts) }).eq('id', cid));
  must(await db.from('loyalty_ledger').insert({ customer_id: cid, order_id: oid, points: pts, type }));
};
const canSeeLoyalty = (u: Profile, cid: string) => {
  if (u.role === 'customer' && u.id !== cid) throw new HttpError(403, 'Forbidden');
};

// ---------- 1-2. system ----------
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.use('/api', auth);
app.get('/api/me', (_, res) => res.json(me(res)));

// ---------- 3-6. menu management ----------
app.get('/api/menu', h(async (_, res) => {
  let q = db.from('menu_items').select('*').order('category').order('name');
  if (me(res).role === 'customer') q = q.eq('available', true);
  res.json(must(await q));
}));

app.post('/api/menu', admin, h(async (req, res) => {
  const { name, category, price, available } = req.body;
  if (!name || price == null) throw new HttpError(400, 'name and price required');
  res.status(201).json(must(await db.from('menu_items').insert({ name, category, price, available }).select().single()));
}));

app.put('/api/menu/:id', admin, h(async (req, res) => {
  const { name, category, price, available } = req.body;
  res.json(must(await db.from('menu_items').update({ name, category, price, available }).eq('id', req.params.id).select().single()));
}));

app.delete('/api/menu/:id', admin, h(async (req, res) => {
  const { error } = await db.from('menu_items').delete().eq('id', req.params.id);
  if (error?.code === '23503') { // used by past orders: hide it instead of deleting
    must(await db.from('menu_items').update({ available: false }).eq('id', req.params.id));
    return res.json({ archived: true });
  }
  must({ data: null, error });
  res.json({ deleted: true });
}));

// ---------- 7-11. order processing ----------
app.get('/api/orders', h(async (req, res) => {
  const u = me(res);
  let q = db.from('orders').select('*, payments(status,method)').order('created_at', { ascending: false }).limit(100);
  if (u.role === 'customer') q = q.eq('customer_id', u.id);
  if (req.query.status) q = q.eq('status', String(req.query.status));
  res.json(must(await q));
}));

app.get('/api/orders/:id', h(async (req, res) => res.json(await getOrder(req.params.id, me(res)))));

app.post('/api/orders', h(async (req, res) => {
  const u = me(res);
  const { items, customer_id, method } = req.body;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'items required');
  const menu = must(await db.from('menu_items').select('id,price,available').in('id', items.map((i: any) => i.menu_item_id)));
  let total = 0;
  const lines = items.map((i: any) => { // prices always come from the DB, never the client
    const m = menu.find((x: any) => x.id === i.menu_item_id);
    if (!m || !m.available || !Number.isInteger(i.qty) || i.qty < 1) throw new HttpError(400, 'Invalid item');
    total += m.price * i.qty;
    return { menu_item_id: m.id, qty: i.qty, price: m.price };
  });
  total = money(total);
  const isStaff = u.role !== 'customer'; // staff/admin = POS walk-in, customer = mobile
  const order = must(await db.from('orders').insert({
    customer_id: isStaff ? customer_id ?? null : u.id, source: isStaff ? 'pos' : 'mobile', total,
  }).select().single());
  must(await db.from('order_items').insert(lines.map((l: any) => ({ ...l, order_id: order.id }))));
  must(await db.from('payments').insert({ order_id: order.id, amount: total, method: method ?? 'cash' }));
  res.status(201).json(order);
}));

app.patch('/api/orders/:id/status', staff, h(async (req, res) => {
  if (!['pending', 'preparing', 'ready', 'completed'].includes(req.body.status)) throw new HttpError(400, 'Invalid status');
  res.json(must(await db.from('orders').update({ status: req.body.status }).eq('id', req.params.id).select().single()));
}));

app.post('/api/orders/:id/cancel', h(async (req, res) => {
  const u = me(res);
  const o = await getOrder(req.params.id, u);
  if (['completed', 'cancelled'].includes(o.status) || o.payments.status === 'paid')
    throw new HttpError(409, 'Cannot cancel (use refund for paid orders)');
  if (u.role === 'customer' && o.status !== 'pending') throw new HttpError(409, 'Order is already being prepared');
  const used = must(await db.from('loyalty_ledger').select('points').eq('order_id', o.id).eq('type', 'redeem'));
  const back = -used.reduce((s: number, r: any) => s + r.points, 0);
  if (o.customer_id) await adjust(o.customer_id, o.id, back, 'earn'); // give redeemed points back
  must(await db.from('payments').update({ status: 'failed', updated_at: now() }).eq('order_id', o.id));
  res.json(must(await db.from('orders').update({ status: 'cancelled' }).eq('id', o.id).select().single()));
}));

// ---------- 12-14. payment status ----------
app.get('/api/orders/:id/payment', h(async (req, res) => res.json((await getOrder(req.params.id, me(res))).payments)));

app.patch('/api/orders/:id/payment', staff, h(async (req, res) => {
  const { status, method } = req.body;
  if (!['pending', 'paid', 'failed'].includes(status)) throw new HttpError(400, 'Invalid status');
  const o = await getOrder(req.params.id, me(res));
  if (o.status === 'cancelled' || ['paid', 'refunded'].includes(o.payments.status))
    throw new HttpError(409, 'Payment is final (use refund)');
  const payment = must(await db.from('payments').update({ status, method, updated_at: now() }).eq('order_id', o.id).select().single());
  const pts = status === 'paid' && o.customer_id ? earned(o.total) : 0; // loyalty hook
  if (pts) await adjust(o.customer_id, o.id, pts, 'earn');
  res.json({ payment, points_earned: pts });
}));

app.post('/api/orders/:id/refund', admin, h(async (req, res) => {
  const o = await getOrder(req.params.id, me(res));
  if (o.payments.status !== 'paid') throw new HttpError(409, 'Only paid orders can be refunded');
  must(await db.from('payments').update({ status: 'refunded', updated_at: now() }).eq('order_id', o.id));
  must(await db.from('orders').update({ status: 'cancelled' }).eq('id', o.id));
  if (o.customer_id) await adjust(o.customer_id, o.id, -earned(o.total), 'earn'); // reverse points
  res.json({ refunded: o.payments.amount });
}));

// ---------- 15-17. loyalty points ----------
app.get('/api/loyalty/:customerId', h(async (req, res) => {
  canSeeLoyalty(me(res), req.params.customerId);
  res.json(must(await db.from('profiles').select('id,name,points').eq('id', req.params.customerId).single()));
}));

app.get('/api/loyalty/:customerId/history', h(async (req, res) => {
  const cid = req.params.customerId;
  canSeeLoyalty(me(res), cid);
  const [ledger, purchases] = await Promise.all([
    db.from('loyalty_ledger').select('*').eq('customer_id', cid).order('created_at', { ascending: false }).limit(100),
    db.from('orders').select('id,total,status,created_at,payments(status)').eq('customer_id', cid)
      .order('created_at', { ascending: false }).limit(100),
  ]);
  res.json({ ledger: must(ledger), purchases: must(purchases) }); // points history + purchase history
}));

app.post('/api/loyalty/redeem', h(async (req, res) => {
  const { order_id, points } = req.body;
  const o = await getOrder(order_id, me(res));
  if (!o.customer_id) throw new HttpError(400, 'Order has no customer');
  if (!Number.isInteger(points) || points < 1 || points > o.total) throw new HttpError(400, 'Invalid points');
  if (o.payments.status !== 'pending' || o.status === 'cancelled') throw new HttpError(409, 'Order not open for redemption');
  const c = must(await db.from('profiles').select('points').eq('id', o.customer_id).single());
  if (c.points < points) throw new HttpError(400, 'Not enough points');
  const total = money(o.total - points);
  must(await db.from('orders').update({ total }).eq('id', o.id));
  must(await db.from('payments').update({ amount: total }).eq('order_id', o.id));
  await adjust(o.customer_id, o.id, -points, 'redeem');
  res.json({ total, discount: points });
}));

// ---------- 18. reports (admin only) ----------
app.get('/api/reports/summary', admin, h(async (_, res) => {
  const [o, p, c] = await Promise.all([
    db.from('orders').select('status'),
    db.from('payments').select('amount').eq('status', 'paid'),
    db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'customer'),
  ]);
  const orders = must(o), byStatus: Record<string, number> = {};
  orders.forEach((r: any) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1));
  res.json({
    orders: orders.length, byStatus, customers: c.count,
    revenue: money(must(p).reduce((s: number, r: any) => s + Number(r.amount), 0)),
  });
}));

const port = process.env.PORT ?? 4000;
app.listen(port, () => console.log(`DinePOS API running on :${port}`));