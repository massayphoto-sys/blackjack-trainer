// game-bootstrap.js — Vive en index.html. Su único trabajo es: cuando
// hay sesión activa, revisar si falta el nombre (onboarding) y, en
// cuanto el perfil esté completo, redirigir a game.html. La mesa en sí
// vive en una página aparte (game.html + table-bootstrap.js) para que
// sea una pantalla fija sin scroll, según lo pedido.

import { getCurrentSession, subscribeToAuthChanges } from './auth.js';
import { getMyProfile, updateDisplayName } from './game-repository.js';

const onboardingPanel = document.getElementById('onboardingPanel');
const onboardingForm = document.getElementById('onboardingForm');
const onboardingButton = document.getElementById('onboardingButton');
const displayNameInput = document.getElementById('displayName');

function goToTable() {
  window.location.href = './game.html';
}

function showOnboarding() {
  if (onboardingPanel) onboardingPanel.hidden = false;
}

function hideOnboarding() {
  if (onboardingPanel) onboardingPanel.hidden = true;
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
      onboardingButton.textContent = 'Continuar';
    }
  });
}

async function onSessionChange(session) {
  const active = Boolean(session?.user);
  if (!active) {
    hideOnboarding();
    return;
  }
  try {
    const profile = await getMyProfile();
    if (!profile?.display_name) {
      showOnboarding();
    } else {
      goToTable();
    }
  } catch (error) {
    console.error('No se pudo cargar el perfil:', error);
  }
}

(async function init() {
  try {
    const session = await getCurrentSession();
    await onSessionChange(session);
    subscribeToAuthChanges(onSessionChange);
  } catch (error) {
    console.error('game-bootstrap init error:', error);
  }
})();
