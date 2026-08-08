// app.js — Solo se encarga del formulario de login (enviar magic link)
// y el panel de diagnóstico técnico. El cambio entre pantallas
// (verificando / pedir nombre / redirigiendo) lo maneja game-bootstrap.js,
// que sabe además si el perfil ya tiene nombre guardado.

import { CONFIG } from './config.js';
import { checkAuthHealth } from './supabase.js';
import { sendMagicLink } from './auth.js';

const el = (id) => document.getElementById(id);
const ui = {
  loginForm: el('loginForm'), loginButton: el('loginButton'), email: el('email'),
  message: el('message'), connectionDot: el('connectionDot'), connectionLabel: el('connectionLabel'),
  toggleDiag: el('toggleDiag'), diagBox: el('diagBox'),
  diagOrigin: el('diagOrigin'), diagSupabase: el('diagSupabase'), diagNetwork: el('diagNetwork'), diagAuth: el('diagAuth'), diagSession: el('diagSession'),
};

function setMessage(text = '', type = '') {
  ui.message.textContent = text;
  ui.message.className = `auth-msg${type ? ` ${type}` : ''}`;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function updateNetworkDiagnostic() {
  ui.diagNetwork.textContent = navigator.onLine ? 'Navegador online' : 'Navegador offline';
}

async function runDiagnostics() {
  ui.connectionDot.className = 'status-dot';
  ui.connectionLabel.textContent = 'Verificando conexión…';
  ui.diagOrigin.textContent = window.location.origin;
  ui.diagSupabase.textContent = CONFIG.supabaseUrl;
  ui.diagAuth.textContent = 'Verificando…';
  updateNetworkDiagnostic();

  const health = await checkAuthHealth();
  if (health.ok) {
    ui.connectionDot.className = 'status-dot ok';
    ui.connectionLabel.textContent = 'Supabase conectado';
    ui.diagAuth.textContent = `Disponible · HTTP ${health.status}`;
  } else {
    ui.connectionDot.className = 'status-dot error';
    ui.connectionLabel.textContent = 'No se pudo conectar con Supabase';
    ui.diagAuth.textContent = health.message;
  }
  return health;
}

if (ui.loginForm) {
  ui.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(ui.loginButton, true);
    setMessage('Verificando conexión…');
    try {
      const health = await runDiagnostics();
      if (!health.ok) throw new Error(`No hay conexión con Supabase: ${health.message}`);
      const email = await sendMagicLink(ui.email.value);
      setMessage(`Enlace enviado a ${email}. Revisa también la carpeta de correo no deseado. Si Gmail muestra una advertencia de seguridad al abrir el enlace, presiona "Continuar".`, 'success');
    } catch (error) {
      console.error('Magic Link error:', error);
      setMessage(error?.message || 'No se pudo enviar el enlace de acceso.', 'error');
    } finally {
      setBusy(ui.loginButton, false);
    }
  });
}

if (ui.toggleDiag) {
  ui.toggleDiag.addEventListener('click', () => {
    ui.diagBox.hidden = !ui.diagBox.hidden;
  });
}

window.addEventListener('online', runDiagnostics);
window.addEventListener('offline', updateNetworkDiagnostic);

runDiagnostics().catch((error) => {
  console.error('Diagnostics error:', error);
});
