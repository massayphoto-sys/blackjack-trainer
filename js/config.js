export const CONFIG = Object.freeze({
  appName: 'Blackjack Trainer',
  version: '9.0.0-auth-foundation',
  supabaseUrl: 'https://cnrmmmnndxtjhaboqxhil.supabase.co',
  supabasePublishableKey: 'sb_publishable_O1umLqsF6m11SoVS14aN6w_aiyqQw5t',
  requestTimeoutMs: 12000
});

export function validateConfig() {
  const errors = [];
  if (!CONFIG.supabaseUrl.startsWith('https://')) errors.push('La URL de Supabase no es válida.');
  if (!CONFIG.supabasePublishableKey.startsWith('sb_publishable_')) errors.push('La clave pública de Supabase no es válida.');
  return errors;
}
