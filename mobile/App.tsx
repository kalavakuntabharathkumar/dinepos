import 'react-native-url-polyfill/auto';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});
const API = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000') + '/api';
type Me = { id: string; name: string; role: string; points: number };
const COLOR: Record<string, string> = { pending: '#f59e0b', preparing: '#3b82f6', ready: '#10b981', completed: '#6b7280', cancelled: '#ef4444' };
const pay = (o: any) => (Array.isArray(o.payments) ? o.payments[0] : o.payments);
const money = (n: number) => '₹' + Number(n).toFixed(2);
const day = (d: string) => new Date(d).toLocaleDateString();
const fail = (e: Error) => Alert.alert('Error', e.message);

// Every action goes through the REST API; Supabase is used for login and live updates only.
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

const Btn = ({ label, onPress, light }: { label: string; onPress: () => void; light?: boolean }) => (
  <Pressable style={[s.btn, light && s.btnLight]} onPress={onPress}><Text style={s.btnText}>{label}</Text></Pressable>
);

function Login() {
  const [email, setEmail] = useState('customer1@dinepos.test'), [password, setPassword] = useState('password123');
  const [name, setName] = useState('');
  const go = async (up: boolean) => {
    const { data, error } = up
      ? await sb.auth.signUp({ email, password, options: { data: { name } } })
      : await sb.auth.signInWithPassword({ email, password });
    if (error) Alert.alert('Error', error.message);
    else if (up && !data.session) Alert.alert('Check your email', 'Confirm your address, then sign in.');
  };
  return (
    <View style={s.center}>
      <Text style={s.h1}>🍽️ DinePOS</Text>
      <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" />
      <TextInput style={s.input} value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Your name (new accounts)" />
      <Btn label="Sign in" onPress={() => go(false)} />
      <Btn light label="Create account" onPress={() => go(true)} />
    </View>
  );
}

// ---------- Menu + cart: place an order, optionally redeem loyalty points ----------
function MenuTab({ me, onPlaced }: { me: Me; onPlaced: () => void }) {
  const [menu, setMenu] = useState<any[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [redeem, setRedeem] = useState('');
  useEffect(() => { api('/menu').then(setMenu).catch(fail); }, []);
  const qty = (id: string) => cart[id] ?? 0;
  const total = menu.reduce((t, m) => t + m.price * qty(m.id), 0);

  const place = async () => {
    const items = Object.entries(cart).filter(([, q]) => q > 0).map(([menu_item_id, qty]) => ({ menu_item_id, qty }));
    if (!items.length) return;
    const o = await api('/orders', 'POST', { items });
    const pts = Math.min(Math.floor(Number(redeem)) || 0, me.points, Math.floor(total));
    if (pts > 0) await api('/loyalty/redeem', 'POST', { order_id: o.id, points: pts });
    setCart({}); setRedeem(''); onPlaced();
    Alert.alert('Order placed', 'Pay at the counter. You earn points once it is paid.');
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList data={menu} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 12 }}
        renderItem={({ item: m }) => (
          <View style={s.row}>
            <View style={{ flex: 1 }}><Text style={s.bold}>{m.name}</Text><Text style={s.dim}>{m.category} · {money(m.price)}</Text></View>
            <Pressable style={s.qb} onPress={() => setCart({ ...cart, [m.id]: Math.max(0, qty(m.id) - 1) })}><Text style={s.qt}>−</Text></Pressable>
            <Text style={s.qn}>{qty(m.id)}</Text>
            <Pressable style={s.qb} onPress={() => setCart({ ...cart, [m.id]: qty(m.id) + 1 })}><Text style={s.qt}>+</Text></Pressable>
          </View>
        )} />
      <View style={s.footer}>
        <TextInput style={s.input} value={redeem} onChangeText={setRedeem} keyboardType="number-pad"
          placeholder={`Redeem points (you have ${me.points})`} />
        <Btn label={`Place order · ${money(total)}`} onPress={() => place().catch(fail)} />
      </View>
    </View>
  );
}

// ---------- Orders: live status (updates by itself via Supabase Realtime) ----------
function OrdersTab({ orders, onChange }: { orders: any[]; onChange: () => void }) {
  return (
    <FlatList data={orders} keyExtractor={(o) => o.id} contentContainerStyle={{ padding: 12 }}
      ListEmptyComponent={<Text style={s.dim}>No orders yet.</Text>}
      renderItem={({ item: o }) => {
        const p = pay(o);
        return (
          <View style={s.card}>
            <View style={s.between}>
              <Text style={s.bold}>#{o.id.slice(0, 6)} · {money(o.total)}</Text>
              <Text style={[s.badge, { backgroundColor: COLOR[o.status] }]}>{o.status}</Text>
            </View>
            <Text style={s.dim}>{day(o.created_at)} · payment {p?.status}</Text>
            {o.status === 'pending' && p?.status === 'pending' && (
              <Btn light label="Cancel order" onPress={() => api(`/orders/${o.id}/cancel`, 'POST').then(onChange).catch(fail)} />
            )}
          </View>
        );
      }} />
  );
}

// ---------- Points: balance, points ledger, purchase history ----------
function PointsTab({ me, orders }: { me: Me; orders: any[] }) {
  const [h, setH] = useState<any>(null);
  useEffect(() => { api(`/loyalty/${me.id}/history`).then(setH).catch(fail); }, [me.id, me.points, orders]);
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <View style={[s.card, { alignItems: 'center' }]}>
        <Text style={s.dim}>Loyalty balance</Text><Text style={s.big}>{me.points} pts</Text>
        <Text style={s.dim}>Earn 1 point per ₹10 · 1 point = ₹1 off</Text>
      </View>
      <Text style={s.h2}>Points history</Text>
      {h?.ledger.map((l: any) => (
        <View key={l.id} style={s.row}><Text style={{ flex: 1 }}>{day(l.created_at)} · {l.type}</Text><Text style={s.bold}>{l.points > 0 ? '+' : ''}{l.points}</Text></View>
      ))}
      <Text style={s.h2}>Purchase history</Text>
      {h?.purchases.map((p: any) => (
        <View key={p.id} style={s.row}><Text style={{ flex: 1 }}>{day(p.created_at)} · {p.status}</Text><Text style={s.bold}>{money(p.total)}</Text></View>
      ))}
    </ScrollView>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null), [orders, setOrders] = useState<any[]>([]), [tab, setTab] = useState('Menu');
  const refresh = useCallback(async () => { setMe(await api('/me')); setOrders(await api('/orders')); }, []);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
    const { data } = sb.auth.onAuthStateChange((_, session) => setToken(session?.access_token ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { // live sync: any change to my orders or their payments refreshes the app
    if (!token) { setMe(null); return; }
    refresh().catch(fail);
    const live = () => refresh().catch(fail);
    const ch = sb.channel('my-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, live)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, live)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [token, refresh]);

  if (token === undefined) return null;
  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" />
      {!token ? <Login /> : !me ? <Text style={s.dim}>Loading…</Text> : me.role !== 'customer' ? (
        <View style={s.center}><Text style={s.h2}>Staff use the web dashboard.</Text><Btn label="Sign out" onPress={() => sb.auth.signOut()} /></View>
      ) : (
        <>
          <View style={s.between}>
            <Text style={s.h1}>🍽️ DinePOS</Text>
            <Text style={s.link} onPress={() => sb.auth.signOut()}>{me.points} pts · Sign out</Text>
          </View>
          <View style={{ flex: 1 }}>
            {tab === 'Menu' && <MenuTab me={me} onPlaced={() => { refresh().catch(fail); setTab('Orders'); }} />}
            {tab === 'Orders' && <OrdersTab orders={orders} onChange={() => refresh().catch(fail)} />}
            {tab === 'Points' && <PointsTab me={me} orders={orders} />}
          </View>
          <View style={s.tabs}>
            {['Menu', 'Orders', 'Points'].map((t) => (
              <Pressable key={t} style={s.tab} onPress={() => setTab(t)}><Text style={[s.tabText, t === tab && s.tabOn]}>{t}</Text></Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, paddingTop: 50, backgroundColor: '#f5f5f2' }, center: { flex: 1, justifyContent: 'center', padding: 24 },
  h1: { fontSize: 24, fontWeight: '700', padding: 12 }, h2: { fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 4 },
  input: { backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  btn: { backgroundColor: '#f59e0b', borderRadius: 8, padding: 13, alignItems: 'center', marginVertical: 4 },
  btnLight: { backgroundColor: '#fef3c7' }, btnText: { fontWeight: '700', color: '#1f2937' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: '#eee' },
  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 10 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bold: { fontWeight: '700' }, dim: { color: '#6b7280', marginTop: 2 }, link: { color: '#2563eb', paddingRight: 12 },
  badge: { color: '#fff', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden', fontWeight: '700' },
  qb: { backgroundColor: '#e5e7eb', borderRadius: 6, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  qt: { fontSize: 18, fontWeight: '700' }, qn: { width: 30, textAlign: 'center', fontWeight: '700' }, big: { fontSize: 36, fontWeight: '700' },
  footer: { padding: 12, backgroundColor: '#fff', borderTopWidth: 1, borderColor: '#e5e7eb' },
  tabs: { flexDirection: 'row', backgroundColor: '#1f2937', paddingBottom: 18 }, tab: { flex: 1, padding: 14, alignItems: 'center' },
  tabText: { color: '#9ca3af', fontWeight: '700' }, tabOn: { color: '#f59e0b' },
});