import 'dotenv/config';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const PASS = 'password123';
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const ok = (r: { error: any }) => { if (r.error) throw new Error(r.error.message); };

async function user(email: string, name: string, role: string) {
  const c = await db.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { name } });
  const id = c.data.user?.id ?? (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  ok(await db.from('profiles').update({ name, role }).eq('id', id)); // profile row is made by the signup trigger
  return id;
}

async function main() {
  const { count } = await db.from('orders').select('id', { count: 'exact', head: true });
  if ((count ?? 0) >= 200) return console.log(`Already seeded (${count} orders). Skipping.`);

  await user('admin@dinepos.test', 'Demo Admin', 'admin');
  await user('staff@dinepos.test', 'Demo Staff', 'staff');
  const names = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Aditya', 'Ishita', 'Rohan', 'Meera', 'Karthik', 'Sneha'];
  const customers: string[] = [];
  for (const [i, n] of names.entries()) customers.push(await user(`customer${i + 1}@dinepos.test`, n, 'customer'));

  let { data: menu } = await db.from('menu_items').select('id,price');
  if (!menu?.length) {
    const items = ('Margherita Pizza|Main|299,Paneer Tikka|Starter|249,Veg Burger|Main|179,Chicken Biryani|Main|329,Butter Naan|Bread|49,'
      + 'Dal Makhani|Main|219,French Fries|Starter|129,Caesar Salad|Starter|189,Masala Dosa|Main|119,Cold Coffee|Drinks|99,'
      + 'Fresh Lime Soda|Drinks|69,Gulab Jamun|Dessert|89').split(',');
    ok(await db.from('menu_items').insert(items.map((s) => { const [name, category, price] = s.split('|'); return { name, category, price: +price }; })));
    menu = (await db.from('menu_items').select('id,price')).data!;
  }

  // 220 orders, oldest first, spread over ~70 days, so loyalty balances build up in order
  const balance = new Map(customers.map((c) => [c, 0]));
  const orders: any[] = [], lines: any[] = [], pays: any[] = [], ledger: any[] = [];
  for (let i = 0; i < 220; i++) {
    const id = randomUUID();
    const at = new Date(Date.now() - (220 - i) * 7.5 * 3600e3).toISOString();
    const cid = Math.random() < 0.8 ? pick(customers) : null; // null = anonymous walk-in
    const cancelled = Math.random() < 0.05;
    let subtotal = 0;
    for (let k = 0, n = rnd(1, 4); k < n; k++) {
      const m = pick(menu), qty = rnd(1, 3);
      subtotal += m.price * qty;
      lines.push({ order_id: id, menu_item_id: m.id, qty, price: m.price });
    }
    const cap = cid ? Math.min(balance.get(cid)!, Math.floor(subtotal / 2)) : 0;
    const redeem = !cancelled && cap >= 10 && Math.random() < 0.15 ? rnd(10, cap) : 0;
    const total = subtotal - redeem;
    orders.push({ id, customer_id: cid, source: cid && Math.random() < 0.7 ? 'mobile' : 'pos',
      status: cancelled ? 'cancelled' : 'completed', total, created_at: at });
    pays.push({ order_id: id, amount: total, method: pick(['cash', 'card', 'upi']),
      status: cancelled ? 'failed' : 'paid', updated_at: at });
    if (cid && redeem) {
      ledger.push({ customer_id: cid, order_id: id, points: -redeem, type: 'redeem', created_at: at });
      balance.set(cid, balance.get(cid)! - redeem);
    }
    if (cid && !cancelled) { // same rule as the API: 1 point per 10 spent, earned when paid
      const pts = Math.floor(total / 10);
      ledger.push({ customer_id: cid, order_id: id, points: pts, type: 'earn', created_at: at });
      balance.set(cid, balance.get(cid)! + pts);
    }
  }

  ok(await db.from('orders').insert(orders));
  ok(await db.from('order_items').insert(lines));
  ok(await db.from('payments').insert(pays));
  ok(await db.from('loyalty_ledger').insert(ledger));
  for (const [c, points] of balance) ok(await db.from('profiles').update({ points }).eq('id', c));
  console.log(`Seeded ${orders.length} orders, ${lines.length} order items, ${ledger.length} loyalty entries.`);
  console.log(`Logins (password "${PASS}"): admin@dinepos.test, staff@dinepos.test, customer1@dinepos.test`);
}

main().catch((e) => { console.error(e); process.exit(1); });