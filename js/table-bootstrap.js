// table-bootstrap.js — Vive en game.html. Verifica sesión activa (si no,
// redirige a index.html), carga el perfil, muestra el nombre del
// jugador y conecta el botón de cerrar sesión arriba, llena la tarjeta
// de estadísticas y la barra del zapato, y abre las hojas de "Comprar
// fichas" / "Cambiar límites" cuando el jugador les da clic.

import { getCurrentSession, subscribeToAuthChanges, signOut } from './auth.js';
import { getMyProfile, getActiveSession } from './game-repository.js';
import { BlackjackTableController } from './game-ui.js';

const startScreen = document.getElementById('startScreen');
const tableRoot = document.getElementById('tableRoot');
const tableScreen = document.getElementById('tableScreen');
const playerNameLabel = document.getElementById('playerNameLabel');
const signOutButton = document.getElementById('signOutButton');
const buyChipsButton = document.getElementById('buyChipsButton');
const limitsButton = document.getElementById('limitsButton');
const reportsButton = document.getElementById('reportsButton');

const statsCard = document.getElementById('statsCard');
const statPrecision = document.getElementById('statPrecision');
const statPrecisionSub = document.getElementById('statPrecisionSub');
const statAvgTime = document.getElementById('statAvgTime');
const statStreak = document.getElementById('statStreak');
const statBestStreak = document.getElementById('statBestStreak');
const statSessionTime = document.getElementById('statSessionTime');
const statSessionHands = document.getElementById('statSessionHands');

const shoeBar = document.getElementById('shoeBar');
const shoeNumberLabel = document.getElementById('shoeNumberLabel');
const cardsRemainingLabel = document.getElementById('cardsRemainingLabel');
const pctPlayedLabel = document.getElementById('pctPlayedLabel');
const cutPctLabel = document.getElementById('cutPctLabel');
const handNumberLabel = document.getElementById('handNumberLabel');

let controller = null;
let myProfile = null;

function handleUpdate(data) {
  statsCard.hidden = false;
  shoeBar.hidden = false;

  statPrecision.textContent = data.precisionPct === null ? '—' : `${data.precisionPct}%`;
  statPrecisionSub.textContent = `${data.correctDecisions} / ${data.totalDecisions}`;
  statAvgTime.textContent = data.avgResponseSec === null ? '—' : `${data.avgResponseSec}s`;
  statStreak.textContent = `${data.streak > 0 ? '+' : ''}${data.streak}`;
  statStreak.className = `stat-value ${data.streak > 0 ? 'green' : data.streak < 0 ? 'red' : ''}`;
  statBestStreak.textContent = `mejor: ${data.bestStreak}`;
  statSessionTime.textContent = `${data.elapsedMin} min`;
  statSessionHands.textContent = `${data.handsThisSession} manos`;

  shoeNumberLabel.textContent = data.shoeNumber;
  cardsRemainingLabel.textContent = data.cardsRemaining;
  pctPlayedLabel.textContent = `${data.pctPlayed}%`;
  cutPctLabel.textContent = `${data.cutPct}%`;
  handNumberLabel.textContent = data.handNumberInShoe;
}

function openSheet(innerHtml, wireFn) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet">${innerHtml}</div>`;
  (tableScreen || document.body).appendChild(backdrop);
  backdrop.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => backdrop.remove()));
  wireFn(backdrop);
}

function openLimitsSheet() {
  if (!controller) return;
  openSheet(`
    <h3>Cambiar límites de mesa</h3>
    <label>Apuesta mínima <input id="sheetMinBet" type="number" min="1" step="1" value="${controller.minimumBet}"></label>
    <label>Apuesta máxima <input id="sheetMaxBet" type="number" min="1" step="1" value="${controller.maximumBet}"></label>
    <div class="sheet-actions">
      <button class="cancel" data-close type="button">Cancelar</button>
      <button class="confirm" data-save-limits type="button">Guardar</button>
    </div>
  `, (backdrop) => {
    backdrop.querySelector('[data-save-limits]').addEventListener('click', () => {
      controller.setTableLimits(Number(document.getElementById('sheetMinBet').value), Number(document.getElementById('sheetMaxBet').value));
      backdrop.remove();
    });
  });
}

function openBuyChipsSheet() {
  if (!controller) return;
  openSheet(`
    <h3>Comprar fichas</h3>
    <label>Monto <input id="sheetBuyAmount" type="number" min="1" step="10" value="100"></label>
    <div class="sheet-actions">
      <button class="cancel" data-close type="button">Cancelar</button>
      <button class="confirm" data-buy-chips type="button">Comprar</button>
    </div>
  `, (backdrop) => {
    backdrop.querySelector('[data-buy-chips]').addEventListener('click', () => {
      controller.buyChips(Number(document.getElementById('sheetBuyAmount').value));
      backdrop.remove();
    });
  });
}

function makeController() {
  return new BlackjackTableController({
    root: tableRoot,
    playerName: myProfile?.display_name || '',
    minimumBet: 20,
    maximumBet: 2000,
    onUpdate: handleUpdate,
  });
}

async function handleStartNew(button) {
  button.disabled = true;
  button.textContent = 'Preparando mesa…';
  try {
    controller = makeController();
    await controller.startSession();
    startScreen.remove();
    await controller.dealNewHand();
  } catch (error) {
    console.error('No se pudo iniciar la mesa:', error);
    button.disabled = false;
    alert(error?.message || 'No se pudo iniciar la mesa de juego.');
  }
}

async function handleResume(button, activeSession) {
  button.disabled = true;
  button.textContent = 'Retomando…';
  try {
    controller = makeController();
    controller.resumeSession(activeSession);
    startScreen.remove();
    await controller.dealNewHand();
  } catch (error) {
    console.error('No se pudo retomar la sesión:', error);
    button.disabled = false;
    alert(error?.message || 'No se pudo retomar la sesión.');
  }
}

async function renderStartScreen() {
  let activeSession = null;
  try {
    activeSession = await getActiveSession();
  } catch (error) {
    console.error('No se pudo revisar si había una sesión activa:', error);
  }

  if (activeSession) {
    const bankroll = Number(activeSession.bankroll_start) + Number(activeSession.total_profit || 0);
    startScreen.innerHTML = `
      <h1>Tienes una sesión sin terminar</h1>
      <p>Ibas con $${bankroll.toFixed(2)} de saldo y ${activeSession.total_hands || 0} manos jugadas. El zapato empieza de cero, pero tu saldo y estadísticas se retoman.</p>
      <button id="resumeButton" type="button">Continuar sesión</button>
      <button id="newSessionButton" type="button" class="secondary-start-btn">Empezar sesión nueva</button>
    `;
    document.getElementById('resumeButton').addEventListener('click', (e) => handleResume(e.target, activeSession));
    document.getElementById('newSessionButton').addEventListener('click', (e) => handleStartNew(e.target));
  } else {
    startScreen.innerHTML = `
      <h1>Listo para entrenar</h1>
      <p>Cada mano que juegues se analiza y se guarda para medir tu criterio, no solo tu resultado.</p>
      <button id="newSessionButton" type="button">Empezar a entrenar</button>
    `;
    document.getElementById('newSessionButton').addEventListener('click', (e) => handleStartNew(e.target));
  }
}

if (buyChipsButton) buyChipsButton.addEventListener('click', openBuyChipsSheet);
if (limitsButton) limitsButton.addEventListener('click', openLimitsSheet);
if (reportsButton) reportsButton.addEventListener('click', () => { window.location.href = './reports.html'; });

if (signOutButton) {
  signOutButton.addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión y salir de la mesa?')) return;
    if (controller) await controller.endSession();
    await signOut();
    window.location.href = './index.html';
  });
}

async function guardSession(session) {
  const active = Boolean(session?.user);
  if (!active) { window.location.href = './index.html'; return; }
  try {
    myProfile = await getMyProfile();
    if (!myProfile?.display_name) { window.location.href = './index.html'; return; }
    playerNameLabel.textContent = myProfile.display_name;
    if (!controller) await renderStartScreen();
  } catch (error) {
    console.error('No se pudo cargar el perfil:', error);
  }
}

(async function init() {
  try {
    const session = await getCurrentSession();
    await guardSession(session);
    subscribeToAuthChanges(guardSession);
  } catch (error) {
    console.error('table-bootstrap init error:', error);
  }
})();
