import { BlackjackTableController } from './game-ui.js?v=mobile-fit-4';
import { clearLegacyAppCache, previewRepository } from './preview.js?v=multiplayer-1';
import { openBuyChipsDialog, openLimitsDialog } from './hud-dialogs.js?v=2';

const byId = id => document.getElementById(id);
const tableRoot = byId('tableRoot');

function handleUpdate(data) {
  byId('statsCard').hidden = false;
  byId('shoeBar').hidden = false;
  byId('statPrecision').textContent = data.precisionPct === null ? '—' : `${data.precisionPct}%`;
  byId('statPrecisionSub').textContent = `${data.correctDecisions} / ${data.totalDecisions}`;
  byId('statAvgTime').textContent = data.avgResponseSec === null ? '—' : `${data.avgResponseSec}s`;
  byId('statStreak').textContent = `${data.streak > 0 ? '+' : ''}${data.streak}`;
  byId('statBestStreak').textContent = data.bestStreak;
  byId('statSessionTime').textContent = `${data.elapsedMin} min`;
  byId('statSessionHands').textContent = data.handsThisSession;
  byId('statSessionHandsMirror').textContent = data.handsThisSession;
  byId('statPrecisionMirror').textContent = data.precisionPct === null ? '—' : `${data.precisionPct}%`;
  byId('statEvLoss').textContent = Number(data.totalEvLoss || 0).toFixed(2);
  byId('hudBankroll').textContent = Math.round(data.bankroll || 0).toLocaleString('en-US');
  byId('shoeNumberLabel').textContent = data.shoeNumber;
  byId('cardsRemainingLabel').textContent = data.cardsRemaining;
  byId('pctPlayedLabel').textContent = `${data.pctPlayed}%`;
  byId('cutPctLabel').textContent = `${data.cutPct}%`;
  byId('handNumberLabel').textContent = data.handNumberInShoe;
  byId('decksRemainingLabel').textContent = (data.cardsRemaining / 52).toFixed(1);
}

clearLegacyAppCache().catch(error => console.warn('No se pudo limpiar el caché anterior:', error));

const controller = new BlackjackTableController({
  root: tableRoot,
  playerName: 'Jugador Demo',
  minimumBet: 20,
  maximumBet: 2000,
  onUpdate: handleUpdate,
  repository: previewRepository,
});

byId('buyChipsButton').addEventListener('click', () => openBuyChipsDialog(controller));
byId('limitsButton').addEventListener('click', () => openLimitsDialog(controller));
byId('reportsButton').addEventListener('click', () => { window.location.href = './reports.html?preview=1&view=nav-3'; });
byId('exitButton').addEventListener('click', () => { window.location.href = './index.html'; });
byId('hudMenuButton').addEventListener('click', () => { byId('hudUtilityMenu').hidden = !byId('hudUtilityMenu').hidden; });

await controller.startSession();
await controller.dealNewHand();
