// table-bootstrap.js — Vive en game.html. Verifica sesión activa (si no,
// redirige a index.html), carga el perfil, y arma el "chrome" alrededor
// de BlackjackTableController: header, tarjeta de estadísticas, barra
// del zapato, y la hoja de ajustes (límites / comprar fichas).

import { getCurrentSession, subscribeToAuthChanges, signOut } from './auth.js';
import { getMyProfile } from './game-repository.js';
import { BlackjackTableController } from './game-ui.js';

const startScreen = document.getElementById('startScreen');
const startButton = document.getElementById('startSessionButton');
const tableRoot = document.getElementById('tableRoot');
const menuButton = document.getElementById('menuButton');
const profileButton = document.getElementById('profileButton');

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
  statStreak.className = `stat-value ${data.streak < 0 ? '' : 'green'}`;
  statBestStreak.textContent = `mejor: ${data.bestStreak}`;
  statSessionTime.textContent = `${data.elapsedMin} min`;
  statSessionHands.textContent = `${data.handsThisSession} manos`;

  shoeNumberLabel.textContent = data.shoeNumber;
  cardsRemainingLabel.textContent = data.cardsRemaining;
  pctPlayedLabel.textContent = `${data.pctPlayed}%`;
  cutPctLabel.textContent = `${data.cutPct}%`;
  handNumberLabel.textContent = data.handNumberInShoe;
}

function openSettingsSheet() {
  if (!controller) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet">
      <h3>Ajustes de mesa</h3>
      <label>Apuesta mínima <input id="sheetMinBet" type="number" min="1" step="1" value="${controller.minimumBet}"></label>
      <label>Apuesta máxima <input id="sheetMaxBet" type="number" min="1" step="1" value="${controller.maximumBet}"></label>
      <div class="sheet-actions">
        <button class="cancel" data-close type="button">Cancelar</button>
        <button class="confirm" data-save-limits type="button">Guardar límites</button>
      </div>
      <h3>Comprar fichas</h3>
      <label>Monto <input id="sheetBuyAmount" type="number" min="1" step="10" value="100"></label>
      <div class="sheet-actions">
        <button class="cancel" data-close type="button">Cancelar</button>
        <button class="confirm" data-buy-chips type="button">Comprar</button>
      </div>
      <div class="sheet-actions">
        <button class="cancel" data-signout type="button">Cerrar sesión</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => backdrop.remove()));
  backdrop.querySelector('[data-save-limits]').addEventListener('click', () => {
    controller.setTableLimits(Number(document.getElementById('sheetMinBet').value), Number(document.getElementById('sheetMaxBet').value));
    backdrop.remove();
  });
  backdrop.querySelector('[data-buy-chips]').addEventListener('click', () => {
    controller.buyChips(Number(document.getElementById('sheetBuyAmount').value));
    backdrop.remove();
  });
  backdrop.querySelector('[data-signout]').addEventListener('click', async () => {
    backdrop.remove();
    if (controller) await controller.endSession();
    await signOut();
    window.location.href = './index.html';
  });
}

async function handleStart() {
  startButton.disabled = true;
  startButton.textContent = 'Preparando mesa…';
  try {
    controller = new BlackjackTableController({
      root: tableRoot, playerName: myProfile?.display_name || '', minimumBet: 20, maximumBet: 2000, onUpdate: handleUpdate,
    });
    await controller.startSession();
    startScreen.remove();
    await controller.dealNewHand();
  } catch (error) {
    console.error('No se pudo iniciar la mesa:', error);
    startButton.disabled = false;
    startButton.textContent = 'Empezar a entrenar';
    alert(error?.message || 'No se pudo iniciar la mesa de juego.');
  }
}

if (startButton) startButton.addEventListener('click', handleStart);
if (menuButton) menuButton.addEventListener('click', openSettingsSheet);
if (profileButton) profileButton.addEventListener('click', openSettingsSheet);

async function guardSession(session) {
  const active = Boolean(session?.user);
  if (!active) { window.location.href = './index.html'; return; }
  try {
    myProfile = await getMyProfile();
    if (!myProfile?.display_name) { window.location.href = './index.html'; return; }
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
