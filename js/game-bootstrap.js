// game-bootstrap.js — Vive en index.html. Maneja el cambio entre las
// 4 pantallas posibles según el estado de sesión/perfil:
// signedOutView (login) → checkingView (procesando) →
// onboardingPanel (pedir nombre, solo la primera vez) → redirectingView
// (camino a game.html). Con reintento breve para evitar el falso
// negativo si el perfil tarda un instante en estar disponible justo
// después de procesar el magic link.

import { getCurrentSession, subscribeToAuthChanges } from './auth.js';
import { getMyProfile, updateDisplayName } from './game-repository.js';

const el = (id) => document.getElementById(id);
const views = {
  signedOut: el('signedOutView'),
  checking: el('checkingView'),
  onboarding: el('onboardingPanel'),
  redirecting: el('redirectingView'),
};
const onboardingForm = el('onboardingForm');
const onboardingButton = el('onboardingButton');
const displayNameInput = el('displayName');

function showOnly(name) {
  Object.entries(views).forEach(([key, node]) => {
    if (node) node.hidden = key !== name;
  });
}

function goToTable() {
  showOnly('redirecting');
  window.location.href = './game.html';
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchProfileWithRetry() {
  try {
    return await getMyProfile();
  } catch (error) {
    await sleep(500);
    return await getMyProfile();
  }
}

if (onboardingForm) {
  onboardingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = displayNameInput.value.trim();
    if (!name) return;
    onboardingButton.disabled = true;
    onboardingButton.textContent = 'Guardando…';
    try {
      await updateDisplayName(name);
      goToTable();
    } catch (error) {
      console.error('No se pudo guardar el nombre:', error);
      alert(error?.message || 'No se pudo guardar el nombre.');
      onboardingButton.disabled = false;
      onboardingButton.textContent = 'Comenzar';
    }
  });
}

async function onSessionChange(session) {
  const active = Boolean(session?.user);
  if (!active) {
    showOnly('signedOut');
    return;
  }
  showOnly('checking');
  try {
    const profile = await fetchProfileWithRetry();
    if (!profile?.display_name) {
      showOnly('onboarding');
    } else {
      goToTable();
    }
  } catch (error) {
    console.error('No se pudo cargar el perfil:', error);
    showOnly('onboarding'); // si el perfil sigue sin poder leerse, mejor pedir el nombre que dejar la pantalla congelada
  }
}

(async function init() {
  try {
    const session = await getCurrentSession();
    await onSessionChange(session);
    subscribeToAuthChanges(onSessionChange);
  } catch (error) {
    console.error('game-bootstrap init error:', error);
    showOnly('signedOut');
  }
})();
