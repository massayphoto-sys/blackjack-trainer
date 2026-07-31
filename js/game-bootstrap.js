// game-bootstrap.js — Punto de entrada que conecta la mesa de juego
// (game-ui.js) con el estado de autenticación (auth.js), sin tocar la
// lógica interna de app.js. Además maneja el paso de onboarding
// (pedir el nombre la primera vez) antes de mostrar el botón de jugar.

import { getCurrentSession, subscribeToAuthChanges } from './auth.js';
import { BlackjackTableController } from './game-ui.js';
import { getMyProfile, updateDisplayName } from './game-repository.js';

const onboardingPanel = document.getElementById('onboardingPanel');
const onboardingForm = document.getElementById('onboardingForm');
const onboardingButton = document.getElementById('onboardingButton');
const displayNameInput = document.getElementById('displayName');

const startPanel = document.getElementById('gameStartPanel');
const startButton = document.getElementById('startSessionButton');
const tableRoot = document.getElementById('blackjackTable');

let controller = null;
let myProfile = null;

function hideAllPanels() {
  if (onboardingPanel) onboardingPanel.hidden = true;
  if (startPanel) startPanel.hidden = true;
  if (tableRoot) { tableRoot.hidden = true; tableRoot.innerHTML = ''; }
  controller = null;
}

function showOnboarding() {
  if (onboardingPanel) onboardingPanel.hidden = false;
  if (startPanel) startPanel.hidden = true;
  if (tableRoot) tableRoot.hidden = true;
}

function showStartPanel() {
  if (onboardingPanel) onboardingPanel.hidden = true;
  if (startPanel) startPanel.hidden = false;
  if (tableRoot) tableRoot.hidden = true;
  if (startButton) {
    startButton.disabled = false;
    startButton.textContent = 'Empezar a entrenar';
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
      myProfile = await updateDisplayName(name);
      showStartPanel();
    } catch (error) {
      console.error('No se pudo guardar el nombre:', error);
      alert(error?.message || 'No se pudo guardar el nombre.');
    } finally {
      onboardingButton.disabled = false;
      onboardingButton.textContent = 'Continuar';
    }
  });
}

async function handleStartClick() {
  if (!startButton || !tableRoot) return;
  startButton.disabled = true;
  startButton.textContent = 'Preparando mesa…';
  try {
    controller = new BlackjackTableController({
      root: tableRoot,
      playerName: myProfile?.display_name || '',
      minimumBet: 20,
      maximumBet: 2000,
    });
    await controller.startSession();
    startPanel.hidden = true;
    tableRoot.hidden = false;
    await controller.dealNewHand();
  } catch (error) {
    console.error('No se pudo iniciar la mesa:', error);
    startButton.disabled = false;
    startButton.textContent = 'Empezar a entrenar';
    alert(error?.message || 'No se pudo iniciar la mesa de juego.');
  }
}

if (startButton) {
  startButton.addEventListener('click', handleStartClick);
}

async function onSessionChange(session) {
  const active = Boolean(session?.user);
  if (!active) {
    hideAllPanels();
    return;
  }
  try {
    myProfile = await getMyProfile();
    if (!myProfile?.display_name) {
      showOnboarding();
    } else {
      showStartPanel();
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
