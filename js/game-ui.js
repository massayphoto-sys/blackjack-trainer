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

export class BlackjackTableController {
  constructor({ root, initialBankroll = 500, minimumBet = 5, maximumBet = 500 }) {
    this.root = root;
    this.game = createGame({ numDecks: 6 });
    this.bankroll = initialBankroll;
    this.minimumBet = minimumBet;
    this.maximumBet = maximumBet;
    this.currentBet = minimumBet;
    this.session = null;
    this.currentShoeRow = null;
    this.hand = null;
    this.sessionTotals = { totalHands: 0, correctDecisions: 0, incorrectDecisions: 0, totalProfit: 0, totalEvLoss: 0 };
  }

  async startSession() {
    this.session = await repo.createTrainingSession({
      bankrollStart: this.bankroll,
      minimumBet: this.minimumBet,
      maximumBet: this.maximumBet,
      gameMode: 'heads_up',
    });
  }

  async ensureShoe() {
    if (shoeNeedsReplacement(this.game)) {
      // Si había un zapato anterior, ciérralo (guarda estado final)
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
    await this.ensureShoe();
    if (this.currentBet > this.bankroll) {
      throw new Error('Saldo insuficiente para esta apuesta.');
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
    const legal = availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted());
    if (!legal.includes(action)) return; // el botón no debería estar habilitado, doble chequeo

    applyPlayerAction(this.game, this.hand, action);
    this.render();

    if (allPlayerHandsResolved(this.hand)) {
      await this.finishHand();
    }
  }

  currentActiveHandsCommitted() {
    return this.hand?.playerHands?.reduce((s, h) => s + h.bet, 0) ?? 0;
  }

  async finishHand() {
    if (!this.hand.naturalBlackjackResolved) {
      playDealerHand(this.game, this.hand);
    }
    const { handResults, totalProfit } = resolveHandResults(this.hand);

    this.bankroll += totalProfit;
    updateStreak(this.game, totalProfit);

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

    this.render(); // refresca el saldo y muestra las cartas finales de la casa
    this.renderResult(handResults, totalProfit);
  }

  async endSession() {
    if (this.session) await repo.endTrainingSession(this.session.id, this.bankroll);
  }

  // --- Renderizado mínimo. Ajustar a la identidad visual real del proyecto. ---

  render() {
    if (!this.root || !this.hand) return;
    const dealerVisible = this.hand.naturalBlackjackResolved
      ? this.hand.dealerCards
      : (allPlayerHandsResolved(this.hand) ? this.hand.dealerCards : [this.hand.dealerCards[0]]);

    const legal = availableActions(this.hand, this.bankroll - this.currentActiveHandsCommitted());

    this.root.innerHTML = `
      <div class="table-dealer">
        <h3>Casa</h3>
        <div class="cards">${this.renderCards(dealerVisible)}</div>
      </div>
      <div class="table-player">
        <h3>Jugador (apuesta $${this.currentBet})</h3>
        ${this.hand.playerHands.map((h, i) => `
          <div class="hand ${i === this.hand.activeHandIndex ? 'active' : ''}">
            <div class="cards">${this.renderCards(h.cards)}</div>
            <div class="total">${handValue(h.cards).total}${h.status !== 'active' ? ` — ${h.status}` : ''}</div>
          </div>
        `).join('')}
      </div>
      <div class="actions">
        ${['hit','stand','double','split'].map(a => `
          <button data-action="${a}" ${legal.includes(a) ? '' : 'disabled'}>${a.toUpperCase()}</button>
        `).join('')}
      </div>
      <div class="bankroll">Saldo: $${this.bankroll.toFixed(2)}</div>
    `;

    this.root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => this.playerAction(btn.dataset.action));
    });
  }

  renderCards(cards) {
    return cards.map(c => `<span class="card">${c.rank}${c.suit}</span>`).join(' ');
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

  renderResult(handResults, totalProfit) {
    if (!this.root) return;
    const banner = document.createElement('div');
    banner.className = `result-banner ${totalProfit > 0 ? 'win' : totalProfit < 0 ? 'loss' : 'push'}`;
    banner.innerHTML = `
      <p>Resultado: ${totalProfit > 0 ? '+' : ''}$${totalProfit.toFixed(2)}</p>
      <button data-next-hand type="button">Siguiente mano</button>
    `;
    this.root.appendChild(banner);
    banner.querySelector('[data-next-hand]').addEventListener('click', () => {
      banner.remove();
      this.dealNewHand();
    });
  }
}
