import { CONFIG } from './config.js';
import { checkAuthHealth } from './supabase.js';
import { getCurrentSession, sendMagicLink, signOut, subscribeToAuthChanges } from './auth.js';

const el = (id) => document.getElementById(id);
const ui = {
  signedOut: el('signedOutView'), signedIn: el('signedInView'), email: el('email'),
  loginForm: el('loginForm'), loginButton: el('loginButton'), logoutButton: el('logoutButton'),
  userEmail: el('userEmail'), message: el('message'), connectionDot: el('connectionDot'),
  connectionLabel: el('connectionLabel'), retryButton: el('retryButton'),
  diagOrigin: el('diagOrigin'), diagSupabase: el('diagSupabase'), diagNetwork: el('diagNetwork'),
  diagAuth: el('diagAuth'), diagSession: el('diagSession')
};

function setMessage(text = '', type = '') {
  ui.message.textContent = text;
  ui.message.className = `message${type ? ` ${type}` : ''}`;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function renderSession(session) {
  const active = Boolean(session?.user);
  ui.signedOut.hidden = active;
  ui.signedIn.hidden = !active;
  ui.userEmail.textContent = session?.user?.email || '—';
  ui.diagSession.textContent = active ? 'Activa' : 'Sin sesión';
  document.documentElement.dataset.authenticated = String(active);
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

ui.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(ui.loginButton, true);
  setMessage('Verificando conexión…');
  try {
    const health = await runDiagnostics();
    if (!health.ok) throw new Error(`No hay conexión con Supabase: ${health.message}`);
    const email = await sendMagicLink(ui.email.value);
    setMessage(`Enlace enviado a ${email}. Revisa también la carpeta de correo no deseado.`, 'success');
  } catch (error) {
    console.error('Magic Link error:', error);
    setMessage(error?.message || 'No se pudo enviar el enlace de acceso.', 'error');
  } finally {
    setBusy(ui.loginButton, false);
  }
});

ui.logoutButton.addEventListener('click', async () => {
  setBusy(ui.logoutButton, true);
  setMessage('Cerrando sesión…');
  try {
    await signOut();
    setMessage('Sesión cerrada.', 'success');
  } catch (error) {
    setMessage(error?.message || 'No se pudo cerrar la sesión.', 'error');
  } finally {
    setBusy(ui.logoutButton, false);
  }
});

ui.retryButton.addEventListener('click', runDiagnostics);
window.addEventListener('online', runDiagnostics);
window.addEventListener('offline', updateNetworkDiagnostic);

async function start() {
  try {
    await runDiagnostics();
    const session = await getCurrentSession();
    renderSession(session);
    subscribeToAuthChanges(renderSession);
  } catch (error) {
    console.error('Initialization error:', error);
    ui.diagSession.textContent = 'Error';
    setMessage(error?.message || 'No se pudo iniciar la aplicación.', 'error');
  }
}

start();
