import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG, validateConfig } from './config.js';

const configErrors = validateConfig();
if (configErrors.length) throw new Error(configErrors.join(' '));

export const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  },
  global: {
    headers: { 'X-Client-Info': `${CONFIG.appName}/${CONFIG.version}` }
  }
});

export async function checkAuthHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        apikey: CONFIG.supabasePublishableKey,
        Authorization: `Bearer ${CONFIG.supabasePublishableKey}`
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, status: response.status };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Tiempo de espera agotado' : (error?.message || 'Error de red');
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}
