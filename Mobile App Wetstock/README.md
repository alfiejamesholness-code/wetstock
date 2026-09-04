# Wetstock — React + Vite prototype (Step 3: Products wired to Supabase)

This is a plain React app that recreates the Wetstock phone prototype's
design and behaviour. As of Step 3, the **Products** screen only is wired
to a real Supabase database — adding or editing a product writes to the
`products` table, and the list loads from it. Everything else (sessions,
stock levels, deliveries, transfers, recounts) is still in-memory and
resets on reload — that's expected until later steps.

## Run it

1. Copy `.env.local.example` to `.env.local`.
2. In your Supabase project: **Settings → API**, copy the **Project URL**
   and the **anon / public** key (not `service_role` — that one must never
   go in this file). Paste them into `.env.local`.
3. Install and run:

```bash
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173) in your browser,
or on your phone if it's on the same wifi network (use the "Network" URL
Vite prints, e.g. http://192.168.x.x:5173).

## What's in here

- `src/constants.js` — design tokens, categories, units, seeded sites, the PIN.
- `src/supabaseClient.js` — the Supabase connection, reading the two
  `VITE_...` variables from `.env.local`.
- `src/components/` — reusable pieces: Header/TabBar/Banner (Chrome.jsx),
  bottom sheet (Sheet.jsx), buttons/inputs/toast/empty-state (Primitives.jsx).
- `src/App.jsx` — everything else: all app state (role, products, sessions,
  stock, etc.), the stock-movement logic, and all 10 screens. The Products
  screen reads and writes `products` via Supabase; everything else is
  still `useState` only.

## Checking Step 3 worked

1. Go to **More → Product range → Add product**, fill in a name, save.
2. Refresh the page — the product should still be there (it's no longer
   just in memory).
3. In Supabase, go to **Table Editor → products** and confirm the row is
   there. **If you don't see it, stop here and fix it before moving on** —
   check the browser console for an error, and confirm `.env.local` has
   the right URL and anon key and that you restarted `npm run dev` after
   creating it (Vite only reads env files on startup).

## Step 5: real logins

The old "PIN to unlock manager view" was a placeholder — gone now. Instead:

1. Run `step5-auth-setup.sql` (included in this folder) in Supabase's
   SQL Editor. This turns Row Level Security back on for `products`
   (with real rules: everyone logged in can read, only managers can
   write), and sets up an automatic `profiles` row for anyone who logs
   in for the first time (defaulting to `staff`).
2. Create your own login: Supabase → **Authentication → Users → Add
   user**, enter an email and password.
3. Make yourself a manager — back in the SQL Editor, run the one-line
   `update profiles set role = 'manager' where id = ...` command at the
   bottom of `step5-auth-setup.sql`, with your real email swapped in.
4. Open the app — it now shows a sign-in screen. Log in with that email
   and password.

A manager sees the small eye icon in the header, which lets them preview
the staff view without logging out (harmless, since they still have full
access underneath). Staff accounts (role left as `staff`) only ever see
Sessions — no toggle, since their role comes from their own login. There's
also a sign-out icon in the header now.
