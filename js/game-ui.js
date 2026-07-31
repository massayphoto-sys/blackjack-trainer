// game-ui.js — Capa de interfaz: conecta game.js (reglas) con el DOM y
// game-repository.js (persistencia). No contiene lógica de juego ni de
// base de datos — solo orquesta y renderiza.

import {
  createGame, dealInitialRound, availableActions, applyPlayerAction,
  allPlayerHandsResolved, playDealerHand, resolveInsurance,
  resolveHandResults, updateStreak, shoeNeedsReplacement, startNewShoe,
} from './game.js';
import { handValue } from './deck.js';
import * as repo from './game-repository.js';

const RESULT_LABELS = {
  win: 'WIN', blackjack: 'WIN', loss: 'LOSE', push: 'PUSH',
};

export class BlackjackTableController {
  constructor({ root, playerName = '', initialBankroll = 500, minimumBet = 20, maximumBet = 2000 }) {
    this.root = root;
    this.playerName = playerName;
    this.game = createGame({ numDecks: 6 });
    this.bankroll = initialBankroll;
    this.bankrollStart = initialBankroll; // fijo, para calcular % ganancia/pérdida acumulada
    this.minimumBet = minimumBet;
    this.maximumBet = maximumBet;
    this.currentBet = minimumBet;
    this.session = null;
    this.currentShoeRow = null;
    this.hand = null;
    this.lastError = null;
    this.lastHandResults = null; // se guarda para mostrar WIN/LOSE/PUSH junto a cada mano
    this.editingLimits = false;
    this.buyingChips = false;
    this.sessionTotals = { totalHands: 0, correctDecisions: 0, incorrectDecisions: 0, totalProfit: 0, totalEvLoss: 0 };
  }

  async startSession() {
    try {
      this.session = await repo.createTrainingSession({
        bankrollStart: this.bankroll,
        minimumBet: this.minimumBet,
        maximumBet: this.maximumBet,
        gameMode: 'heads_up',
      });
    } catch (error) {
      this.lastError = error?.message || String(error);
      throw error;
    }
  }

  async ensureShoe() {
    if (shoeNeedsReplacement(this.game)) {
      if (this.game.shoe && this.currentShoeRow) {
        await repo.saveShoe({
          id: this.currentShoeRow.id,
          sessionId: this.session.id,
          shoeNumber: this.game.shoeNumber,
          shoe: this.game.shoe,
          endedAt: new Date().toISOString(),
        });
      }
      startNewShoe(this.game);
      this.currentShoeRow = await repo.saveShoe({
        sessionId: this.session.id,
        shoeNumber: this.game.shoeNumber,
        shoe: this.game.shoe,
      });
    }
  }

  /** Inicia una mano nueva: reparte, revisa blackjack natural, pregunta insurance si aplica. */
  async dealNewHand() {
    try {
      this.lastError = null;
      this.lastHandResults = null;
      await this.ensureShoe();
      if (this.currentBet > this.bankroll) {
        throw new Error('Saldo insuficiente para esta apuesta. Compra más fichas o baja tu apuesta.');
      }

      const previousBet = this.hand?.playerHands?.[0]?.bet ?? null;
      this.hand = dealInitialRound(this.game, {
        betAmount: this.currentBet,
        bankrollBeforeHand: this.bankroll,
        previousBetAmount: previousBet,
      });

      this.render();

      if (this.hand.naturalBlackjackResolved) {
        await this.finishHand();
      } else if (this.hand.insurance.offered) {
        this.renderInsurancePrompt();
      }
    } catch (error) {
      console.error('dealNewHand error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  async decideInsurance(taken) {
    const amount = taken ? this.currentBet / 2 : 0;
    resolveInsurance(this.hand, taken, amount);
    if (this.hand.playerHands.every(h => h.status === 'dealer_blackjack')) {
      await this.finishHand();
    } else {
      this.render();
    }
  }

  /** Llamado desde los botones Pedir/Plantarse/Doblar/Dividir. */
  async playerAction(action) {
    try {
      const legal = availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted());
      if (!legal.includes(action)) return;

      applyPlayerAction(this.game, this.hand, action);
      this.render();

      if (allPlayerHandsResolved(this.hand)) {
        await this.finishHand();
      }
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
      if (!this.hand.naturalBlackjackResolved) {
        playDealerHand(this.game, this.hand);
      }
      const { handResults, totalProfit } = resolveHandResults(this.hand);

      this.bankroll += totalProfit;
      updateStreak(this.game, totalProfit);
      this.lastHandResults = { handResults, totalProfit };

      await repo.saveResolvedHand({
        sessionId: this.session.id,
        shoeId: this.currentShoeRow.id,
        hand: this.hand,
        handResults,
        totalProfit,
        seatNumber: 1,
      });

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

  /** Compra simulada de fichas: aumenta el bankroll. No afecta bankroll_start (para no distorsionar el % de ganancia/pérdida real de juego). */
  buyChips(amount) {
    if (!amount || amount <= 0) return;
    this.bankroll += amount;
    this.bankrollStart += amount; // el "capital aportado" también sube, así el % refleja rendimiento de juego, no la compra
    this.buyingChips = false;
    this.render();
  }

  /** Cambia los límites de la mesa. Ajusta la apuesta actual si queda fuera de rango. */
  setTableLimits(minBet, maxBet) {
    if (minBet <= 0 || maxBet < minBet) return;
    this.minimumBet = minBet;
    this.maximumBet = maxBet;
    this.currentBet = Math.min(Math.max(this.currentBet, minBet), maxBet);
    this.editingLimits = false;
    this.render();
  }

  adjustBet(delta) {
    const next = this.currentBet + delta;
    if (next < this.minimumBet || next > this.maximumBet || next > this.bankroll) return;
    this.currentBet = next;
    this.render();
  }

  // --- Métricas derivadas para el panel ---

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

  // --- Renderizado. Ajustar clases CSS a la identidad visual real del proyecto. ---

  render() {
    if (!this.root) return;

    const resolved = this.hand ? allPlayerHandsResolved(this.hand) : true;
    const dealerVisible = this.hand
      ? (this.hand.naturalBlackjackResolved ? this.hand.dealerCards : (resolved ? this.hand.dealerCards : [this.hand.dealerCards[0]]))
      : [];

    const legal = (this.hand && !this.hand.naturalBlackjackResolved)
      ? availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted())
      : [];

    const shoe = this.game.shoe;
    const cardsRemaining = shoe ? shoe.totalCards - shoe.dealtSequence.length : 0;
    const pctPlayed = shoe ? Math.round((shoe.dealtSequence.length / shoe.totalCards) * 1000) / 10 : 0;
    const cutPct = shoe ? shoe.penetrationPct : 0;
    const remainingPct = this.shoeRemainingPct();

    const streak = this.game.currentStreak;
    const streakBadge = streak !== 0
      ? `<span class="streak-badge ${streak > 0 ? 'positive' : 'negative'}">Racha ${streak > 0 ? '+' : ''}${streak} ${streak > 0 ? '↑' : '↓'}</span>`
      : '';

    const profitPct = this.profitPct();
    const profitBadge = `<span class="profit-badge ${profitPct > 0 ? 'positive' : profitPct < 0 ? 'negative' : 'neutral'}">Ganancia/pérdida: ${profitPct > 0 ? '+' : ''}${profitPct}% ${profitPct > 0 ? '↑' : profitPct < 0 ? '↓' : ''}</span>`;

    const dealerTotal = dealerVisible.length ? handValue(dealerVisible).total : 0;
    const results = this.lastHandResults?.handResults ?? null;

    this.root.innerHTML = `
      <div class="table-mesa">
        <h3>Mesa${this.playerName ? ` — ${this.escapeHtml(this.playerName)}` : ''}</h3>
        ${this.editingLimits ? `
          <div class="limits-editor">
            <label>Mínimo <input id="minBetInput" type="number" min="1" step="1" value="${this.minimumBet}"></label>
            <label>Máximo <input id="maxBetInput" type="number" min="1" step="1" value="${this.maximumBet}"></label>
            <button data-save-limits type="button">Guardar</button>
            <button data-cancel-limits type="button">Cancelar</button>
          </div>
        ` : `
          <p class="mesa-limites">
            Límites: $${this.minimumBet.toFixed(2)} mínimo · $${this.maximumBet.toFixed(2)} máximo
            <button data-edit-limits type="button" class="text-button">Cambiar límites</button>
          </p>
        `}
        ${this.buyingChips ? `
          <div class="chips-editor">
            <label>Monto a comprar <input id="buyChipsInput" type="number" min="1" step="10" value="100"></label>
            <button data-confirm-buy type="button">Confirmar compra</button>
            <button data-cancel-buy type="button">Cancelar</button>
          </div>
        ` : `
          <button data-buy-chips type="button" class="text-button">Comprar fichas</button>
        `}
        <div class="stats-line">
          ${profitBadge}
          <span class="shoe-count">Zapatos jugados: ${this.game.shoeNumber}</span>
          <span class="shoe-remaining">Manos restantes en este zapato: ${remainingPct}%</span>
        </div>
        ${this.lastError ? `<div class="error-banner">Error interno: ${this.escapeHtml(this.lastError)}</div>` : ''}
      </div>

      ${this.hand ? `
        <div class="table-dealer">
          <div class="dealer-header">
            <h3>Casa</h3>
            <span class="shoe-info">Zapato ${this.game.shoeNumber} · ${cardsRemaining} cartas restantes · ${pctPlayed}% jugado · corte al ${cutPct}%</span>
            <span class="hand-total">Total: ${dealerTotal}</span>
          </div>
          <div class="cards">${this.renderCards(dealerVisible)}</div>
        </div>

        <div class="table-player">
          <div class="player-header">
            <h3>Jugador</h3>
            ${streakBadge}
            <span class="hand-total">Total: ${handValue(this.hand.playerHands[this.hand.activeHandIndex]?.cards ?? this.hand.playerHands[0].cards).total}</span>
          </div>
          ${this.hand.playerHands.map((h, i) => {
            const r = results ? results[i] : null;
            const resultClass = r ? r.result : '';
            const resultLabel = r ? (RESULT_LABELS[r.result] || r.result.toUpperCase()) : '';
            return `
              <div class="hand ${i === this.hand.activeHandIndex ? 'active' : ''} ${resultClass}">
                <div class="cards">${this.renderCards(h.cards)}</div>
                ${resultLabel ? `<div class="result-label">${resultLabel}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>

        <div class="bet-controls">
          <span>Apuesta próxima mano: $${this.currentBet}</span>
          <button data-bet-delta="-5" type="button" ${resolved ? '' : 'disabled'}>-5</button>
          <button data-bet-delta="5" type="button" ${resolved ? '' : 'disabled'}>+5</button>
          <button data-bet-delta="-25" type="button" ${resolved ? '' : 'disabled'}>-25</button>
          <button data-bet-delta="25" type="button" ${resolved ? '' : 'disabled'}>+25</button>
        </div>

        <div class="actions">
          ${['hit','stand','double','split'].map(a => `
            <button data-action="${a}" ${legal.includes(a) ? '' : 'disabled'}>${a.toUpperCase()}</button>
          `).join('')}
          ${resolved && this.lastHandResults ? `<button data-next-hand type="button" class="primary">Siguiente mano</button>` : ''}
        </div>
      ` : ''}

      <div class="bankroll">Saldo: $${this.bankroll.toFixed(2)}</div>
    `;

    this.wireEvents();
  }

  wireEvents() {
    this.root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => this.playerAction(btn.dataset.action));
    });
    const nextBtn = this.root.querySelector('[data-next-hand]');
    if (nextBtn) nextBtn.addEventListener('click', () => this.dealNewHand());
    this.root.querySelectorAll('[data-bet-delta]').forEach(btn => {
      btn.addEventListener('click', () => this.adjustBet(Number(btn.dataset.betDelta)));
    });

    const editLimitsBtn = this.root.querySelector('[data-edit-limits]');
    if (editLimitsBtn) editLimitsBtn.addEventListener('click', () => { this.editingLimits = true; this.render(); });
    const cancelLimitsBtn = this.root.querySelector('[data-cancel-limits]');
    if (cancelLimitsBtn) cancelLimitsBtn.addEventListener('click', () => { this.editingLimits = false; this.render(); });
    const saveLimitsBtn = this.root.querySelector('[data-save-limits]');
    if (saveLimitsBtn) saveLimitsBtn.addEventListener('click', () => {
      const min = Number(this.root.querySelector('#minBetInput').value);
      const max = Number(this.root.querySelector('#maxBetInput').value);
      this.setTableLimits(min, max);
    });

    const buyChipsBtn = this.root.querySelector('[data-buy-chips]');
    if (buyChipsBtn) buyChipsBtn.addEventListener('click', () => { this.buyingChips = true; this.render(); });
    const cancelBuyBtn = this.root.querySelector('[data-cancel-buy]');
    if (cancelBuyBtn) cancelBuyBtn.addEventListener('click', () => { this.buyingChips = false; this.render(); });
    const confirmBuyBtn = this.root.querySelector('[data-confirm-buy]');
    if (confirmBuyBtn) confirmBuyBtn.addEventListener('click', () => {
      const amount = Number(this.root.querySelector('#buyChipsInput').value);
      this.buyChips(amount);
    });
  }

  renderCards(cards) {
    return cards.map(c => `<span class="card ${['♥','♦'].includes(c.suit) ? 'red' : 'black'}">${c.rank}${c.suit}</span>`).join(' ');
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  renderInsurancePrompt() {
    if (!this.root) return;
    const prompt = document.createElement('div');
    prompt.className = 'insurance-prompt';
    prompt.innerHTML = `
      <p>La casa muestra As — ¿Insurance por $${(this.currentBet / 2).toFixed(2)}?</p>
      <button data-insurance="yes">Sí</button>
      <button data-insurance="no">No</button>
    `;
    this.root.appendChild(prompt);
    prompt.querySelector('[data-insurance="yes"]').addEventListener('click', () => {
      prompt.remove();
      this.decideInsurance(true);
    });
    prompt.querySelector('[data-insurance="no"]').addEventListener('click', () => {
      prompt.remove();
      this.decideInsurance(false);
    });
  }
}
