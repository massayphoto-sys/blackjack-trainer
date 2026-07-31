// game-ui.js — Motor de renderizado de la mesa (réplica del diseño de
// referencia). Dibuja dentro de #tableRoot: fieltro con marca de agua,
// casa, jugador, apuesta, dock de acciones y resumen. La tarjeta de
// estadísticas y la barra del zapato viven en game.html/table-bootstrap.js,
// que reciben los datos vía el callback onUpdate.

import {
  createGame, dealInitialRound, availableActions, applyPlayerAction,
  allPlayerHandsResolved, playDealerHand, resolveInsurance,
  resolveHandResults, updateStreak, shoeNeedsReplacement, startNewShoe,
} from './game.js';
import { handValue } from './deck.js';
import * as repo from './game-repository.js';

const RESULT_LABELS = { win: 'WIN', blackjack: 'WIN', loss: 'LOSE', push: 'PUSH' };

export class BlackjackTableController {
  constructor({ root, playerName = '', initialBankroll = 1000, minimumBet = 20, maximumBet = 2000, onUpdate = () => {} }) {
    this.root = root;
    this.playerName = playerName;
    this.onUpdate = onUpdate;
    this.game = createGame({ numDecks: 6 });
    this.bankroll = initialBankroll;
    this.bankrollStart = initialBankroll;
    this.minimumBet = minimumBet;
    this.maximumBet = maximumBet;
    this.currentBet = minimumBet;
    this.session = null;
    this.currentShoeRow = null;
    this.hand = null;
    this.lastError = null;
    this.lastHandResults = null;
    this.sessionStartedAt = null;
    this.decisionStartedAt = null;
    this.responseTimes = [];
    this.bestStreak = 0;
    this.sessionTotals = { totalHands: 0, correctDecisions: 0, incorrectDecisions: 0, totalProfit: 0, totalEvLoss: 0 };
  }

  async startSession() {
    this.session = await repo.createTrainingSession({
      bankrollStart: this.bankroll, minimumBet: this.minimumBet, maximumBet: this.maximumBet, gameMode: 'heads_up',
    });
    this.sessionStartedAt = Date.now();
  }

  async ensureShoe() {
    if (shoeNeedsReplacement(this.game)) {
      if (this.game.shoe && this.currentShoeRow) {
        await repo.saveShoe({
          id: this.currentShoeRow.id, sessionId: this.session.id, shoeNumber: this.game.shoeNumber,
          shoe: this.game.shoe, endedAt: new Date().toISOString(),
        });
      }
      startNewShoe(this.game);
      this.currentShoeRow = await repo.saveShoe({ sessionId: this.session.id, shoeNumber: this.game.shoeNumber, shoe: this.game.shoe });
    }
  }

  async dealNewHand() {
    try {
      this.lastError = null;
      this.lastHandResults = null;
      await this.ensureShoe();
      if (this.currentBet > this.bankroll) throw new Error('Saldo insuficiente. Compra más fichas o baja tu apuesta.');

      const previousBet = this.hand?.playerHands?.[0]?.bet ?? null;
      this.hand = dealInitialRound(this.game, { betAmount: this.currentBet, bankrollBeforeHand: this.bankroll, previousBetAmount: previousBet });
      this.render();
      if (this.hand.naturalBlackjackResolved) {
        await this.finishHand();
      } else if (this.hand.insurance.offered) {
        this.showInsuranceModal();
      }
    } catch (error) {
      console.error('dealNewHand error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  markDecisionTime() {
    if (this.decisionStartedAt !== null) {
      this.responseTimes.push(Date.now() - this.decisionStartedAt);
      this.decisionStartedAt = null;
    }
  }

  async decideInsurance(taken) {
    this.markDecisionTime();
    const amount = taken ? this.currentBet / 2 : 0;
    resolveInsurance(this.hand, taken, amount);
    if (this.hand.playerHands.every(h => h.status === 'dealer_blackjack')) {
      await this.finishHand();
    } else {
      this.render();
    }
  }

  showInsuranceModal() {
    const amount = (this.currentBet / 2).toFixed(2);
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `
      <div class="sheet">
        <h3>La casa muestra As</h3>
        <p style="margin:0;color:var(--muted);font-size:13px;">¿Tomar seguro por $${amount}? Paga 2 a 1 si el dealer tiene blackjack.</p>
        <div class="sheet-actions">
          <button class="cancel" data-insurance-no type="button">No</button>
          <button class="confirm" data-insurance-yes type="button">Sí, tomar seguro</button>
        </div>
      </div>
    `;
    (this.root.closest('.table-screen') || document.body).appendChild(backdrop);
    backdrop.querySelector('[data-insurance-yes]').addEventListener('click', () => { backdrop.remove(); this.decideInsurance(true); });
    backdrop.querySelector('[data-insurance-no]').addEventListener('click', () => { backdrop.remove(); this.decideInsurance(false); });
  }

  async playerAction(action) {
    try {
      const legal = availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted());
      if (!legal.includes(action)) return;
      this.markDecisionTime();
      applyPlayerAction(this.game, this.hand, action);
      this.render();
      if (allPlayerHandsResolved(this.hand)) await this.finishHand();
    } catch (error) {
      console.error('playerAction error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  currentActiveHandsCommitted() {
    return this.hand?.playerHands?.reduce((s, h) => s + h.bet, 0) ?? 0;
  }

  async finishHand() {
    try {
      if (!this.hand.naturalBlackjackResolved) playDealerHand(this.game, this.hand);
      const { handResults, totalProfit } = resolveHandResults(this.hand);
      this.bankroll += totalProfit;
      updateStreak(this.game, totalProfit);
      this.bestStreak = Math.max(this.bestStreak, this.game.currentStreak);
      this.lastHandResults = { handResults, totalProfit };

      await repo.saveResolvedHand({ sessionId: this.session.id, shoeId: this.currentShoeRow.id, hand: this.hand, handResults, totalProfit, seatNumber: 1 });

      this.sessionTotals.totalHands += 1;
      this.sessionTotals.correctDecisions += this.hand.decisions.filter(d => d.isCorrect).length;
      this.sessionTotals.incorrectDecisions += this.hand.decisions.filter(d => !d.isCorrect).length;
      this.sessionTotals.totalProfit += totalProfit;
      this.sessionTotals.totalEvLoss += this.hand.decisions.reduce((s, d) => s + (d.evLoss || 0), 0);
      await repo.updateSessionTotals(this.session.id, this.sessionTotals);

      this.render();
    } catch (error) {
      console.error('finishHand error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  async endSession() {
    if (this.session) await repo.endTrainingSession(this.session.id, this.bankroll);
  }

  buyChips(amount) {
    if (!amount || amount <= 0) return;
    this.bankroll += amount;
    this.bankrollStart += amount;
    this.render();
  }

  setTableLimits(minBet, maxBet) {
    if (minBet <= 0 || maxBet < minBet) return;
    this.minimumBet = minBet;
    this.maximumBet = maxBet;
    this.currentBet = Math.min(Math.max(this.currentBet, minBet), maxBet);
    this.render();
  }

  adjustBet(delta) {
    const next = this.currentBet + delta;
    if (next < this.minimumBet || next > this.maximumBet || next > this.bankroll) return;
    this.currentBet = next;
    this.render();
  }

  setBetPercentOfBankroll(pct) {
    const raw = Math.round((this.bankroll * pct) / 5) * 5; // redondeado a múltiplos de 5
    const clamped = Math.min(Math.max(raw, this.minimumBet), Math.min(this.maximumBet, this.bankroll));
    this.currentBet = clamped;
    this.render();
  }

  profitPct() {
    if (this.bankrollStart <= 0) return 0;
    return Math.round(((this.bankroll - this.bankrollStart) / this.bankrollStart) * 1000) / 10;
  }

  shoeRemainingPct() {
    const shoe = this.game.shoe;
    if (!shoe) return 100;
    const remaining = Math.max(shoe.cutCardPosition - shoe.dealtSequence.length, 0);
    return Math.round((remaining / shoe.cutCardPosition) * 1000) / 10;
  }

  avgResponseSeconds() {
    if (this.responseTimes.length === 0) return null;
    const avgMs = this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
    return Math.round((avgMs / 1000) * 10) / 10;
  }

  // --- Renderizado ---

  render() {
    if (!this.root) return;

    const resolved = this.hand ? allPlayerHandsResolved(this.hand) : true;
    if (this.hand && !resolved && !this.hand.naturalBlackjackResolved && this.decisionStartedAt === null) {
      this.decisionStartedAt = Date.now();
    }

    const dealerVisible = this.hand
      ? (this.hand.naturalBlackjackResolved ? this.hand.dealerCards : (resolved ? this.hand.dealerCards : [this.hand.dealerCards[0]]))
      : [];
    const insurancePending = Boolean(this.hand?.insurance?.offered && this.hand.insurance.taken === null);
    const legal = (this.hand && !this.hand.naturalBlackjackResolved && !insurancePending)
      ? availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted())
      : [];

    const streak = this.game.currentStreak;
    const dealerTotal = dealerVisible.length ? handValue(dealerVisible).total : 0;
    const results = this.lastHandResults?.handResults ?? null;
    const activeHand = this.hand ? (this.hand.playerHands[this.hand.activeHandIndex] ?? this.hand.playerHands[0]) : null;
    const profitPct = this.profitPct();

    this.root.innerHTML = this.hand ? `
      <div class="felt-watermark">
        <div class="fw-title">BLACKJACK</div>
        <div class="fw-sub">PAGA 3 A 2</div>
        <div class="fw-rules">EL DEALER PIDE EN 16 Y SE PLANTA EN 17<br>EL SEGURO PAGA 2 A 1</div>
      </div>

      <div class="seat">
        <div class="seat-label">Dealer</div>
        <div class="seat-row">
          <div class="card-row dealer-cards">${this.renderCards(dealerVisible)}${(!resolved && !this.hand.naturalBlackjackResolved) ? this.renderFaceDownCard() : ''}</div>
          <div class="total-pill">${dealerTotal}</div>
        </div>
      </div>

      <div class="seat">
        <div class="seat-label">Tú</div>
        <div class="hands-row">
          ${this.hand.playerHands.map((h, i) => {
            const r = results ? results[i] : null;
            const cls = r ? r.result : (i === this.hand.activeHandIndex ? 'active' : '');
            return `
              <div class="hand-slot ${cls}">
                ${this.hand.playerHands.length > 1 ? `<div class="hand-slot-label">Jugada ${i + 1}</div>` : ''}
                <div class="seat-row">
                  <div class="card-row">${this.renderCards(h.cards)}</div>
                  <div class="total-pill">${handValue(h.cards).total}</div>
                </div>
                ${r ? `<div class="result-overlay"><span class="result-word ${r.result}">${RESULT_LABELS[r.result] || r.result.toUpperCase()}</span><span class="result-amount">${r.profit > 0 ? '+' : ''}$${r.profit.toFixed(2)}</span></div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="dock">
        ${this.lastError ? `<div class="error-toast">${this.escapeHtml(this.lastError)}</div>` : ''}

        ${resolved && this.lastHandResults ? `<button class="next-hand-btn" data-next-hand type="button">Siguiente mano</button>` : `
          <div class="action-row">
            <button class="action-btn double" data-action="double" ${legal.includes('double') ? '' : 'disabled'}><span class="icon">2x</span>DOBLAR</button>
            <button class="action-btn hit" data-action="hit" ${legal.includes('hit') ? '' : 'disabled'}><span class="icon">＋</span>PEDIR</button>
            <button class="action-btn stand" data-action="stand" ${legal.includes('stand') ? '' : 'disabled'}><span class="icon">−</span>PLANTARSE</button>
            <button class="action-btn split" data-action="split" ${legal.includes('split') ? '' : 'disabled'}><span class="icon">⇄</span>DIVIDIR</button>
            <button class="action-btn insurance" type="button" disabled title="El seguro se pregunta automáticamente"><span class="icon">🛡</span>SEGURO</button>
          </div>
        `}

        <div class="summary-panel">
          <div class="col"><div class="s-label">Saldo</div><div class="s-value">$${this.bankroll.toFixed(2)}</div></div>
          <div class="col"><div class="s-label">Apuesta actual</div><div class="s-value">$${this.currentBet.toFixed(2)}</div></div>
          <div class="col">
            <div class="s-label">Rendimiento</div>
            <div class="s-value green">${profitPct > 0 ? '+' : ''}${profitPct}%</div>
            <div class="s-sub">${(this.bankroll - this.bankrollStart) >= 0 ? '+' : ''}$${(this.bankroll - this.bankrollStart).toFixed(2)}</div>
          </div>
        </div>

        <div class="quick-bets">
          <button data-bet-delta="-10" type="button" ${resolved ? '' : 'disabled'}>-10</button>
          <button data-bet-delta="-1" type="button" ${resolved ? '' : 'disabled'}>-1</button>
          <button data-bet-pct="0.5" type="button" ${resolved ? '' : 'disabled'}>50%</button>
          <button data-bet-delta="1" type="button" ${resolved ? '' : 'disabled'}>+1</button>
          <button data-bet-delta="10" type="button" ${resolved ? '' : 'disabled'}>+10</button>
        </div>

      </div>
    ` : '';

    this.wireEvents();
    this.emitUpdate();
  }

  emitUpdate() {
    const shoe = this.game.shoe;
    const totalDecisions = this.sessionTotals.correctDecisions + this.sessionTotals.incorrectDecisions;
    const precisionPct = totalDecisions > 0 ? Math.round((this.sessionTotals.correctDecisions / totalDecisions) * 100) : null;
    const elapsedMin = this.sessionStartedAt ? Math.max(1, Math.round((Date.now() - this.sessionStartedAt) / 60000)) : 0;

    this.onUpdate({
      shoeNumber: this.game.shoeNumber,
      cardsRemaining: shoe ? shoe.totalCards - shoe.dealtSequence.length : 0,
      pctPlayed: shoe ? Math.round((shoe.dealtSequence.length / shoe.totalCards) * 1000) / 10 : 0,
      cutPct: shoe ? shoe.penetrationPct : 0,
      handNumberInShoe: this.hand ? this.hand.handNumberInShoe : 0,
      precisionPct, correctDecisions: this.sessionTotals.correctDecisions, totalDecisions,
      avgResponseSec: this.avgResponseSeconds(),
      streak: this.game.currentStreak, bestStreak: this.bestStreak,
      elapsedMin, handsThisSession: this.sessionTotals.totalHands,
    });
  }

  wireEvents() {
    this.root.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => this.playerAction(btn.dataset.action)));
    const nextBtn = this.root.querySelector('[data-next-hand]');
    if (nextBtn) nextBtn.addEventListener('click', () => this.dealNewHand());
    this.root.querySelectorAll('[data-bet-delta]').forEach(btn => btn.addEventListener('click', () => this.adjustBet(Number(btn.dataset.betDelta))));
    const pctBtn = this.root.querySelector('[data-bet-pct]');
    if (pctBtn) pctBtn.addEventListener('click', () => this.setBetPercentOfBankroll(Number(pctBtn.dataset.betPct)));
  }

  renderCards(cards) {
    // La primera carta repartida (índice 0) queda a la derecha, abajo del
    // todo; cada carta siguiente se monta encima y hacia la izquierda —
    // reproduciendo el orden real de reparto. z-index explícito garantiza
    // el apilamiento correcto sin depender del orden del DOM.
    return cards.map((c, i) => `
      <div class="card ${['♥','♦'].includes(c.suit) ? 'red' : ''}" style="z-index:${i};">
        <span class="idx idx-tl">${c.rank}<br>${c.suit}</span>
        <span class="idx idx-br">${c.rank}<br>${c.suit}</span>
      </div>
    `).join('');
  }

  renderFaceDownCard() {
    return `<div class="card face-down" style="z-index:-1;" aria-label="Carta tapada"></div>`;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
