import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    'Supabase env vars are missing. Create a .env.local file with ' +
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — see README.md.'
  );
}

export const supabase = createClient(url, anonKey);
