# Wetstock — React + Vite prototype (Step 1)

This is a plain React app that recreates the Wetstock phone prototype's
design and behaviour, still running entirely on in-memory (in-browser)
state — no database yet. That's the next step in BUILD-WITH-CLAUDE-CODE.md.

## Run it

```bash
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173) in your browser,
or on your phone if it's on the same wifi network (use the "Network" URL
Vite prints, e.g. http://192.168.x.x:5173).

## What's in here

- `src/constants.js` — design tokens, categories, units, seeded sites, the PIN.
- `src/components/` — reusable pieces: Header/TabBar/Banner (Chrome.jsx),
  bottom sheet (Sheet.jsx), buttons/inputs/toast/empty-state (Primitives.jsx).
- `src/App.jsx` — everything else: all app state (role, products, sessions,
  stock, etc, held with `useState`), the stock-movement logic (deliveries,
  sessions, transfers, recounts), and all 10 screens.

Data resets on every page reload — this is expected at this stage.
