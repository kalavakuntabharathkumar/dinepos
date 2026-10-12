# DinePOS - Built by Bharath Kumar

DinePOS is a restaurant app where customers order food from their phone and the staff take walk-in orders at the billing counter, called the POS (Point of Sale).

Every new order shows up live on the kitchen screen, the cashier marks it paid, and the customer earns reward points on every payment.

The owner (admin) can change the menu, give refunds and see total sales, and everything is saved in one online database called Supabase.

---

## How to Run

**You need:** Node.js 20.6 or newer (nodejs.org) and a free Supabase account (supabase.com).

### First time only

1. Create a new project on Supabase and wait about 2 minutes for it to get ready.
2. In Supabase, open **SQL Editor > New query**, paste everything from `schema.sql` and click **Run**. Run it only once. "Success. No rows returned" is the correct result.
3. Make your own `.env` file from the template:
   - Windows: `copy .env.example .env`
   - Mac / Linux: `cp .env.example .env`
4. Open `.env` and fill in your values (no quotes, no spaces around `=`):

   | Value | Where to find it | Paste it in |
   |---|---|---|
   | Project URL | Your dashboard address bar looks like `supabase.com/dashboard/project/abcd1234/...`. Your URL is `https://abcd1234.supabase.co` | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_URL` |
   | anon / publishable key | Project Settings > API Keys | `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
   | service_role / secret key | Same page (keep it private) | `SUPABASE_SERVICE_KEY` |

   Leave `NEXT_PUBLIC_API_URL=http://localhost:4000` as it is.
5. Install and add demo data:
   ```
   npm install
   npm run seed
   ```

### Every time after that

Open two terminals in the project folder:

```
npm run dev:server
```
```
npm run dev:web
```

Then open **http://localhost:3000**. Stop either one with Ctrl+C.

**Demo logins** (password for all is `password123`)
- Admin: `admin@dinepos.test`
- Staff: `staff@dinepos.test`
- Customer: `customer1@dinepos.test` (customers use the phone app)

### Phone app (optional)

1. Install Expo Go on your phone. Phone and computer must be on the same Wi-Fi.
2. Find your computer's IP (`ipconfig` on Windows, look for IPv4) and set `EXPO_PUBLIC_API_URL=http://YOUR-IP:4000` in `.env`. Restart the server.
3. Make sure the file is named `mobile/App.tsx` with a capital A (the app will not start if it is `app.tsx`). On Windows rename in two steps: `ren app.tsx temp.tsx` then `ren temp.tsx App.tsx`.
4. Run:
   ```
   cd mobile
   npm install
   cd ..
   npm run dev:mobile
   ```
5. Scan the QR code with Expo Go. If the scanner does not work, open Expo Go, tap Enter URL manually and type the `exp://...` address shown in the terminal.

### If something goes wrong
- Changed `.env`? Stop both terminals and start them again.
- "Failed to fetch" on login means the backend terminal is not running.
- "Invalid API key" means a key is pasted on the wrong line.
- Phone cannot connect? Your IP changed. Check it again with `ipconfig`.
- Never upload `.env` anywhere. It holds your secret key.

---

## How the Project Works

**Who is who**

```
Phone app / Website  =  the screens people touch
Backend (server)     =  the brain: checks the rules and decides what is allowed
Supabase             =  the memory (database), the login desk and the live messenger
```

**What happens when one order is placed**

```
STEP 1   Customer opens the phone app and types email + password
            |
            v
STEP 2   Supabase checks the password and gives back a login pass (token)
            |
            v
STEP 3   Customer taps + on the food they want and presses "Place order"
            |
            v
STEP 4   The phone sends the order + the login pass to the Backend
            |
            v
STEP 5   Backend checks: is the pass real? is this a customer, staff or admin?
         It takes prices from the database, never from the phone,
         so nobody can cheat on the price
            |
            v
STEP 6   Backend saves the order, the food items and a payment marked "pending"
            |
            v
STEP 7   Supabase tells every open screen "something changed" (live update)
            |
            +--------------------------------+
            v                                v
STEP 8   Kitchen screen shows            Customer's phone shows
         the new order at once           the order as "pending"
            |
            v
STEP 9   Cook taps: Mark preparing > Mark ready > Mark completed
         (each tap goes through the Backend, then every screen updates live)
            |
            v
STEP 10  Customer pays at the counter and staff taps "Mark paid"
         Backend sets payment to "paid" and gives 1 point for every ₹10 spent
            |
            v
STEP 11  Customer sees the new points on the phone
         Points can be used as discount on a later order (1 point = ₹1 off)
            |
            v
STEP 12  Admin opens Reports and sees total orders, total money earned
         and number of customers
```

A walk-in customer follows the same path, except the cashier enters the order on the website's POS tab instead of the phone (Step 3).

**Small rules the backend follows**
- A customer can cancel only while the order is still "pending" and unpaid.
- Only the admin can refund. A refund also takes back the points that order gave.
- A menu item used in old orders is hidden instead of deleted, so old bills stay correct.
- Staff can do everything on the counter. Only the admin can edit the menu, refund and see reports.

---

## Files and What They Do

**schema.sql** - Builds the database. Run once in Supabase.
- 6 tables: `profiles` (users, role, points), `menu_items`, `orders`, `order_items`, `payments`, `loyalty_ledger` (points history)
- `handle_new_user()` - automatically creates a profile when someone signs up
- `is_staff()` - tells the security rules whether the logged-in user is staff or admin
- Security rules (RLS) - customers can read only their own data, staff and admin can read all
- Turns on live updates for orders, payments and menu

**server/index.ts** - The backend. Every change to data passes through here.
- Helpers: `HttpError` (error with a code), `h()` (catches errors so the server never crashes), `must()` (stops if the database returned an error), `money()` (rounds to 2 decimals), `earned()` (1 point per ₹10)
- `auth` - checks the login pass on every request. `allow()`, `staff`, `admin` - block people who are not allowed
- `getOrder()` - fetches one order with its items and payment. `adjust()` - adds or removes points and writes the history. `canSeeLoyalty()` - stops a customer from viewing someone else's points
- Routes: health check and "who am I" - menu list, add, edit, delete - order list, details, create, change status, cancel - payment view, update, refund - loyalty balance, history, redeem - reports summary

**server/seed.ts** - Fills the database with demo data so the app is not empty.
- `user()` - creates a login (admin, staff or customer) and sets its role
- `main()` - creates 1 admin login, 1 staff login, 10 customers, 12 menu items and 220 orders with payments and points. It skips itself if 200 or more orders already exist

**web/app/layout.tsx** - The outer frame of the website (page title and the basic HTML shell). Function: `RootLayout()`.

**web/app/page.tsx** - The whole website (staff and admin only).
- `api()` - sends requests to the backend with the login pass. `useOrders()` - loads the latest 60 orders and refreshes them live. `customers()` - loads the customer list
- `Login()` - sign in box
- `POS()` - build a walk-in order, pick a customer, use points, choose cash/card/UPI, place order
- `Kitchen()` - active orders with a button to move them to the next status
- `Orders()` - table of the latest 60 orders with Mark paid, Cancel and Refund buttons
- `Loyalty()` - customers, their points, purchase history and points history
- `Menu()` - add items, change price, hide/show, delete (admin only)
- `Reports()` - orders, revenue, customers, orders by status (admin only)
- `Page()` - checks login, shows the right tabs for the user's role

**web/tsconfig.json** - Settings for the TypeScript compiler used by the website.

**mobile/App.tsx** - The customer phone app (the name must start with a capital A).
- `api()` - same as the website, talks to the backend. `Btn()` - the reusable button
- `Login()` - sign in or create a new customer account
- `MenuTab()` - browse the menu, fill the cart, use points, place order
- `OrdersTab()` - live order status with a Cancel button while pending
- `PointsTab()` - points balance, points history, purchase history
- `App()` - login check, live updates, bottom tabs

**mobile/app.json and mobile/package.json** - App name and settings, and the libraries the phone app needs.

**package.json** - Libraries for the server and website, plus the commands: `dev:server`, `dev:web`, `dev:mobile`, `seed`, `build:web`.

**.env.example** - Template of the secret settings. Copy it to `.env` and fill it in.

**.gitignore** - Tells Git which files never to upload (`.env`, `node_modules`, build folders).

---

## Future Improvements

1. **Real online payments.** Right now staff mark an order as paid by hand. Connecting Razorpay or a UPI gateway would make payments automatic.
2. **Safer order saving.** Placing an order does three separate saves (order, items, payment). If one fails, a half-made order is left behind. Doing all three in one database transaction fixes that.
3. **Safer points update.** Points are read and then written back, so two quick actions on the same customer could give a wrong balance. A single atomic database update would fix it.
4. **Better reports.** Daily and weekly sales, best selling items, charts and a date filter. Today it shows one total for all time.
5. **Dine-in details.** Table numbers, dine-in or takeaway, and a printable bill for the customer.
6. **Notifications.** A sound in the kitchen for new orders and a phone notification when the order is ready.
7. **Staff and menu extras.** A screen to create staff accounts (today only the seed script does it), food photos and stock counts.
8. **Order details on the phone.** Show the items inside each order, not just the total.
9. **Extra security.** Input checking, rate limiting, CORS limited to the real website, and removing the demo passwords before going live.
10. **Tests and deployment.** Automatic tests for the order and refund rules, then hosting the backend and website online so it works outside localhost.
