// game-bootstrap.js — Punto de entrada que conecta la mesa de juego
// (game-ui.js) con el estado de autenticación (auth.js), sin tocar la
// lógica interna de app.js. Se suscribe de forma independiente a los
// cambios de sesión.

import { getCurrentSession, subscribeToAuthChanges } from './auth.js';
import { BlackjackTableController } from './game-ui.js';

const startPanel = document.getElementById('gameStartPanel');
const startButton = document.getElementById('startSessionButton');
const tableRoot = document.getElementById('blackjackTable');

let controller = null;

function showStartPanel() {
  if (startPanel) startPanel.hidden = false;
  if (tableRoot) tableRoot.hidden = true;
}

function hideEverything() {
  if (startPanel) startPanel.hidden = true;
  if (tableRoot) { tableRoot.hidden = true; tableRoot.innerHTML = ''; }
  controller = null;
}

async function handleStartClick() {
  if (!startButton || !tableRoot) return;
  startButton.disabled = true;
  startButton.textContent = 'Preparando mesa…';
  try {
    controller = new BlackjackTableController({ root: tableRoot });
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
  if (active) {
    showStartPanel();
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = 'Empezar a entrenar';
    }
  } else {
    hideEverything();
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
