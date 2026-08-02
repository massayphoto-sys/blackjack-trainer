// game-ui.js — Motor de renderizado de la mesa (réplica del diseño de
// referencia). Dibuja dentro de #tableRoot: fieltro con marca de agua,
// casa, jugador, apuesta, dock de acciones y resumen. La tarjeta de
// estadísticas y la barra del zapato viven en game.html/table-bootstrap.js,
// que reciben los datos vía el callback onUpdate.

import {
  createGame, dealInitialRound, dealMultiSeatRound, availableActions, applyPlayerAction,
  allPlayerHandsResolved, playDealerHand, playDealerHandMultiSeat, resolveInsurance,
  resolveHandResults, updateStreak, shoeNeedsReplacement, startNewShoe,
  beginShoeShuffle, confirmShoeCut,
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
    this.currentBet2 = minimumBet;
    this.session = null;
    this.currentShoeRow = null;
    this.hand = null;
    this.seat2Open = false;
    this.hand2 = null;
    this.lastHandResults2 = null;
    this.awaitingCut = false;
    this.burnedCardPreview = null;
    this.pendingCutPct = null;
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

  /**
   * Retoma una sesión activa existente (mismo session_id, saldo real,
   * estadísticas acumuladas) en vez de crear una nueva. El zapato SÍ
   * empieza de cero — no se guarda la posición exacta dentro de un
   * zapato entre recargas de página, solo el estado de la sesión.
   */
  async resumeSession(sessionRow) {
    this.session = sessionRow;
    this.bankrollStart = Number(sessionRow.bankroll_start);
    this.bankroll = this.bankrollStart + Number(sessionRow.total_profit || 0);
    this.minimumBet = Number(sessionRow.minimum_bet);
    this.maximumBet = Number(sessionRow.maximum_bet);
    this.currentBet = Math.min(Math.max(this.currentBet, this.minimumBet), this.maximumBet);
    this.sessionTotals = {
      totalHands: sessionRow.total_hands || 0,
      correctDecisions: sessionRow.correct_decisions || 0,
      incorrectDecisions: sessionRow.incorrect_decisions || 0,
      totalProfit: Number(sessionRow.total_profit || 0),
      totalEvLoss: Number(sessionRow.total_ev_loss || 0),
    };
    this.sessionStartedAt = new Date(sessionRow.started_at).getTime();

    // El zapato en sí empieza de cero (no se guarda su posición exacta),
    // pero el CONTADOR sigue donde iba — si ya llevabas 3 zapatos, el
    // próximo que se reparta debe llamarse "Zapato 4", no volver a "1".
    this.game.shoeNumber = await repo.getShoeCountForSession(sessionRow.id);
  }

  /**
   * Arranca el ritual de corte: guarda el zapato anterior (si había),
   * baraja uno nuevo y lo deja pendiente de que el jugador elija dónde
   * cortar — la mesa muestra la pantalla de corte en vez de repartir.
   */
  async startCutRitual() {
    if (this.game.shoe && this.currentShoeRow) {
      await repo.saveShoe({
        id: this.currentShoeRow.id, sessionId: this.session.id, shoeNumber: this.game.shoeNumber,
        shoe: this.game.shoe, endedAt: new Date().toISOString(),
      });
    }
    beginShoeShuffle(this.game);
    this.awaitingCut = true;
    this.burnedCardPreview = null;
    this.pendingCutPct = 0.5; // la tarjeta roja arranca visible en el centro, lista para deslizarse
    this.render();
  }

  /** El jugador tocó un punto del mazo (0 a 1) para insertar la tarjeta roja. */
  async confirmCut(pct) {
    if (!this.game.pendingShoeCards) return;
    const clamped = Math.min(Math.max(pct, 0.05), 0.95); // no dejar cortar en el borde extremo
    const cutPosition = Math.floor(this.game.pendingShoeCards.totalCards * clamped);
    const burned = confirmShoeCut(this.game, cutPosition);
    this.burnedCardPreview = burned;
    this.pendingCutPct = null;
    this.currentShoeRow = await repo.saveShoe({ sessionId: this.session.id, shoeNumber: this.game.shoeNumber, shoe: this.game.shoe });
    this.render();
  }

  /** El jugador ya vio la carta quemada — arranca el reparto normal del zapato nuevo. */
  async continueAfterCut() {
    this.awaitingCut = false;
    this.burnedCardPreview = null;
    await this.dealNewHand();
  }

  /** Elige 1 o 2 puestos Y reparte la próxima mano en el mismo toque — un solo tap, sin ventana de tiempo entre elegir y repartir. */
  async chooseSeatCountAndDeal(count) {
    if (this.currentActiveTarget()) return; // protección extra: nunca cambiar mientras hay una mano sin terminar
    this.seat2Open = count === 2;
    if (!this.seat2Open) this.hand2 = null;
    await this.dealNewHand();
  }

  /** ¿Ya se resolvieron todos los puestos que tienen mano repartida en esta ronda? */
  bothSeatsResolved() {
    const seat1Done = !this.hand || allPlayerHandsResolved(this.hand);
    const seat2Done = !this.hand2 || allPlayerHandsResolved(this.hand2);
    return seat1Done && seat2Done;
  }

  /** ¿Cuál puesto le toca jugar ahora mismo? 'hand', 'hand2', o null si ya no hay nada pendiente. */
  currentActiveTarget() {
    if (this.hand && !allPlayerHandsResolved(this.hand)) return 'hand';
    if (this.hand2 && !allPlayerHandsResolved(this.hand2)) return 'hand2';
    return null;
  }

  async dealNewHand() {
    try {
      this.lastError = null;
      this.lastHandResults = null;
      this.lastHandResults2 = null;

      if (shoeNeedsReplacement(this.game)) {
        await this.startCutRitual();
        return; // el reparto real sigue después de que el jugador corte (continueAfterCut)
      }

      const totalStake = this.seat2Open ? this.currentBet + this.currentBet2 : this.currentBet;
      if (totalStake > this.bankroll) throw new Error('Saldo insuficiente. Compra más fichas o baja tu apuesta.');

      const previousBet = this.hand?.playerHands?.[0]?.bet ?? null;
      const previousBet2 = this.hand2?.playerHands?.[0]?.bet ?? null;

      if (this.seat2Open) {
        const [h1, h2] = dealMultiSeatRound(this.game, [
          { betAmount: this.currentBet, bankrollBeforeHand: this.bankroll, previousBetAmount: previousBet },
          { betAmount: this.currentBet2, bankrollBeforeHand: this.bankroll, previousBetAmount: previousBet2 },
        ]);
        this.hand = h1;
        this.hand2 = h2;
        // v1: con 2 puestos abiertos el seguro se rechaza automáticamente
        // (simplificación — preguntar el seguro por separado para cada
        // puesto queda para una siguiente iteración).
        if (this.hand.insurance.offered) resolveInsurance(this.hand, false, 0);
        if (this.hand2.insurance.offered) resolveInsurance(this.hand2, false, 0);
        this.render();
        if (this.bothSeatsResolved()) await this.finishHand();
      } else {
        this.hand = dealInitialRound(this.game, { betAmount: this.currentBet, bankrollBeforeHand: this.bankroll, previousBetAmount: previousBet });
        this.hand2 = null;
        this.render();
        if (this.hand.naturalBlackjackResolved) {
          await this.finishHand();
        } else if (this.hand.insurance.offered) {
          this.showInsuranceModal();
        }
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
      const target = this.currentActiveTarget();
      if (!target) return;
      const hand = this[target];

      const legal = availableActions(hand, this.bankroll - this.currentActiveHandsCommitted());
      if (!legal.includes(action)) return;

      if (action === 'hit') {
        const active = hand.playerHands[hand.activeHandIndex];
        const { total } = handValue(active.cards);
        if (total >= 17 && total <= 20) {
          const confirmed = await this.confirmRiskyHit(total);
          if (!confirmed) return;
        }
      }

      this.markDecisionTime();
      applyPlayerAction(this.game, hand, action);
      this.render();
      if (this.bothSeatsResolved()) await this.finishHand();
    } catch (error) {
      console.error('playerAction error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  /** Pide confirmación antes de pedir carta con un total ya fuerte (17-20) — protege contra toques accidentales. */
  confirmRiskyHit(total) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'sheet-backdrop';
      backdrop.innerHTML = `
        <div class="sheet">
          <h3>¿Seguro que quieres pedir con ${total}?</h3>
          <p>Es un total ya fuerte — confirma que no fue sin querer.</p>
          <div class="sheet-actions">
            <button class="cancel" type="button">No, mejor no</button>
            <button class="confirm" type="button">Sí, pedir</button>
          </div>
        </div>
      `;
      (this.root.closest('.table-screen') || document.body).appendChild(backdrop);
      backdrop.querySelector('.confirm').addEventListener('click', () => { backdrop.remove(); resolve(true); });
      backdrop.querySelector('.cancel').addEventListener('click', () => { backdrop.remove(); resolve(false); });
    });
  }

  currentActiveHandsCommitted() {
    const h1 = this.hand?.playerHands?.reduce((s, h) => s + h.bet, 0) ?? 0;
    const h2 = this.seat2Open ? (this.hand2?.playerHands?.reduce((s, h) => s + h.bet, 0) ?? 0) : 0;
    return h1 + h2;
  }

  /** Resuelve y guarda UN puesto ya jugado; acumula sus totales de sesión. Devuelve el resultado para mostrarlo. */
  async settleOneSeat(hand, seatNumber) {
    const { handResults, totalProfit, insuranceProfit } = resolveHandResults(hand);
    this.bankroll += totalProfit;

    await repo.saveResolvedHand({
      sessionId: this.session.id,
      shoeId: this.currentShoeRow.id,
      hand,
      handResults,
      totalProfit,
      seatNumber,
    });

    this.sessionTotals.totalHands += 1;
    this.sessionTotals.correctDecisions += hand.decisions.filter(d => d.isCorrect).length;
    this.sessionTotals.incorrectDecisions += hand.decisions.filter(d => !d.isCorrect).length;
    this.sessionTotals.totalProfit += totalProfit;
    this.sessionTotals.totalEvLoss += hand.decisions.reduce((s, d) => s + (d.evLoss || 0), 0);

    return { handResults, totalProfit, insuranceProfit };
  }

  async finishHand() {
    try {
      if (this.hand2) {
        playDealerHandMultiSeat(this.game, [this.hand, this.hand2]);
        this.lastHandResults = await this.settleOneSeat(this.hand, 1);
        this.lastHandResults2 = await this.settleOneSeat(this.hand2, 2);
        updateStreak(this.game, this.lastHandResults.totalProfit + this.lastHandResults2.totalProfit);
      } else {
        if (!this.hand.naturalBlackjackResolved) playDealerHand(this.game, this.hand);
        this.lastHandResults = await this.settleOneSeat(this.hand, 1);
        updateStreak(this.game, this.lastHandResults.totalProfit);
      }
      this.bestStreak = Math.max(this.bestStreak, this.game.currentStreak);
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
    if (this.lastError) {
      this.dealNewHand(); // reintenta el reparto que había fallado por saldo insuficiente
    } else {
      this.render();
    }
  }

  setTableLimits(minBet, maxBet) {
    if (minBet <= 0 || maxBet < minBet) return;
    this.minimumBet = minBet;
    this.maximumBet = maxBet;
    this.currentBet = Math.min(Math.max(this.currentBet, minBet), maxBet);
    if (this.lastError) {
      this.dealNewHand();
    } else {
      this.render();
    }
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

  adjustBet2(delta) {
    const next = this.currentBet2 + delta;
    if (next < this.minimumBet || next > this.maximumBet || next > this.bankroll) return;
    this.currentBet2 = next;
    this.render();
  }

  setBetPercentOfBankroll2(pct) {
    const raw = Math.round((this.bankroll * pct) / 5) * 5;
    const clamped = Math.min(Math.max(raw, this.minimumBet), Math.min(this.maximumBet, this.bankroll));
    this.currentBet2 = clamped;
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

    if (this.awaitingCut) {
      this.renderCutRitual();
      return;
    }

    const resolved = this.bothSeatsResolved();
    if (this.hand && !resolved && !this.hand.naturalBlackjackResolved && this.decisionStartedAt === null) {
      this.decisionStartedAt = Date.now();
    }

    const dealerVisible = this.hand
      ? (resolved ? this.hand.dealerCards : [this.hand.dealerCards[0]])
      : [];
    const insurancePending = Boolean(this.hand?.insurance?.offered && this.hand.insurance.taken === null);
    const activeTarget = this.currentActiveTarget();
    const activeHandObj = activeTarget ? this[activeTarget] : null;
    const legal = (activeHandObj && !insurancePending)
      ? availableActions(activeHandObj, this.bankroll - this.currentActiveHandsCommitted())
      : [];

    const streak = this.game.currentStreak;
    const dealerTotal = dealerVisible.length ? handValue(dealerVisible).total : 0;
    const results = this.lastHandResults?.handResults ?? null;
    const results2 = this.lastHandResults2?.handResults ?? null;
    const bothResultsReady = Boolean(this.lastHandResults && (!this.seat2Open || this.lastHandResults2));
    const insuranceProfit = this.lastHandResults?.insuranceProfit ?? 0;
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
          <div class="card-row dealer-cards">${this.renderCards(dealerVisible)}${!resolved ? this.renderFaceDownCard() : ''}</div>
          <div class="total-pill">${dealerTotal}</div>
        </div>
      </div>

      <div class="seats-row">
        <div class="seat">
          <div class="seat-label">${this.seat2Open ? 'Puesto 1' : 'Tú'}</div>
          <div class="hands-row">
            ${this.hand.playerHands.map((h, i) => {
              const r = results ? results[i] : null;
              const cls = r ? r.result : (i === this.hand.activeHandIndex && activeTarget === 'hand' ? 'active' : '');
              return `
                <div class="hand-slot ${cls}">
                  ${this.hand.playerHands.length > 1 ? `<div class="hand-slot-label">Jugada ${i + 1}</div>` : ''}
                  <div class="seat-row">
                    <div class="card-row">${this.renderCards(h.cards)}</div>
                    <div class="total-pill">${handValue(h.cards).total}</div>
                  </div>
                  ${r ? `<div class="result-overlay">
                    <span class="result-word ${r.result}">${RESULT_LABELS[r.result] || r.result.toUpperCase()}</span>
                    <span class="result-amount">${r.profit > 0 ? '+' : ''}$${r.profit.toFixed(2)}</span>
                    ${insuranceProfit !== 0 ? `
                      <span class="result-insurance">Seguro: ${insuranceProfit > 0 ? '+' : ''}$${insuranceProfit.toFixed(2)}</span>
                      <span class="result-net">Neto: ${(r.profit + insuranceProfit) > 0 ? '+' : ''}$${(r.profit + insuranceProfit).toFixed(2)}</span>
                    ` : ''}
                  </div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        ${this.hand2 ? `
          <div class="seat">
            <div class="seat-label">Puesto 2</div>
            <div class="hands-row">
              ${this.hand2.playerHands.map((h, i) => {
                const r2 = results2 ? results2[i] : null;
                const cls = r2 ? r2.result : (i === this.hand2.activeHandIndex && activeTarget === 'hand2' ? 'active' : '');
                return `
                  <div class="hand-slot ${cls}">
                    ${this.hand2.playerHands.length > 1 ? `<div class="hand-slot-label">Jugada ${i + 1}</div>` : ''}
                    <div class="seat-row">
                      <div class="card-row">${this.renderCards(h.cards)}</div>
                      <div class="total-pill">${handValue(h.cards).total}</div>
                    </div>
                    ${r2 ? `<div class="result-overlay">
                      <span class="result-word ${r2.result}">${RESULT_LABELS[r2.result] || r2.result.toUpperCase()}</span>
                      <span class="result-amount">${r2.profit > 0 ? '+' : ''}$${r2.profit.toFixed(2)}</span>
                    </div>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <div class="dock">
        ${this.lastError ? `<div class="error-toast">${this.escapeHtml(this.lastError)}</div>` : ''}

        ${this.lastError && !legal.length && !(resolved && bothResultsReady) ? `
          <button class="next-hand-btn" data-retry-deal type="button">Reintentar</button>
        ` : resolved && bothResultsReady ? `
          <div class="seat-count-picker">
            <span class="seat-count-label">Siguiente mano:</span>
            <button class="seat-count-btn ${!this.seat2Open ? 'selected' : ''}" data-seat-count="1" type="button">1 puesto</button>
            <button class="seat-count-btn ${this.seat2Open ? 'selected' : ''}" data-seat-count="2" type="button">2 puestos</button>
          </div>
        ` : `
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
          <div class="col">
            <div class="s-label">Apuesta actual</div>
            ${this.hand2 || this.seat2Open ? `
              <div class="s-value small">P1: $${this.currentBet.toFixed(2)}</div>
              <div class="s-value small">P2: $${this.currentBet2.toFixed(2)}</div>
            ` : `<div class="s-value">$${this.currentBet.toFixed(2)}</div>`}
          </div>
          <div class="col">
            <div class="s-label">Rendimiento</div>
            <div class="s-value green">${profitPct > 0 ? '+' : ''}${profitPct}%</div>
            <div class="s-sub">${(this.bankroll - this.bankrollStart) >= 0 ? '+' : ''}$${(this.bankroll - this.bankrollStart).toFixed(2)}</div>
          </div>
        </div>

        ${this.seat2Open || this.hand2 ? `<div class="quick-bets-label">Puesto 1</div>` : ''}
        <div class="quick-bets">
          <button data-bet-delta="-10" type="button" ${resolved ? '' : 'disabled'}>-10</button>
          <button data-bet-delta="-1" type="button" ${resolved ? '' : 'disabled'}>-1</button>
          <button data-bet-pct="0.5" type="button" ${resolved ? '' : 'disabled'}>50%</button>
          <button data-bet-delta="1" type="button" ${resolved ? '' : 'disabled'}>+1</button>
          <button data-bet-delta="10" type="button" ${resolved ? '' : 'disabled'}>+10</button>
        </div>

        ${this.seat2Open || this.hand2 ? `
          <div class="quick-bets-label">Puesto 2</div>
          <div class="quick-bets">
            <button data-bet-delta2="-10" type="button" ${resolved ? '' : 'disabled'}>-10</button>
            <button data-bet-delta2="-1" type="button" ${resolved ? '' : 'disabled'}>-1</button>
            <button data-bet-pct2="0.5" type="button" ${resolved ? '' : 'disabled'}>50%</button>
            <button data-bet-delta2="1" type="button" ${resolved ? '' : 'disabled'}>+1</button>
            <button data-bet-delta2="10" type="button" ${resolved ? '' : 'disabled'}>+10</button>
          </div>
        ` : ''}

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
    const retryBtn = this.root.querySelector('[data-retry-deal]');
    if (retryBtn) retryBtn.addEventListener('click', () => this.dealNewHand());
    this.root.querySelectorAll('[data-bet-delta]').forEach(btn => btn.addEventListener('click', () => this.adjustBet(Number(btn.dataset.betDelta))));
    const pctBtn = this.root.querySelector('[data-bet-pct]');
    if (pctBtn) pctBtn.addEventListener('click', () => this.setBetPercentOfBankroll(Number(pctBtn.dataset.betPct)));
    this.root.querySelectorAll('[data-bet-delta2]').forEach(btn => btn.addEventListener('click', () => this.adjustBet2(Number(btn.dataset.betDelta2))));
    const pctBtn2 = this.root.querySelector('[data-bet-pct2]');
    if (pctBtn2) pctBtn2.addEventListener('click', () => this.setBetPercentOfBankroll2(Number(pctBtn2.dataset.betPct2)));
    this.root.querySelectorAll('[data-seat-count]').forEach(btn => {
      btn.addEventListener('click', () => this.chooseSeatCountAndDeal(Number(btn.dataset.seatCount)));
    });
  }

  renderCutRitual() {
    const totalCards = this.game.pendingShoeCards?.totalCards ?? 0;

    if (this.burnedCardPreview) {
      // Paso 2: ya se cortó — mostrar la carta quemada.
      this.root.innerHTML = `
        <div class="cut-ritual">
          <div class="cut-ritual-icon">🔥</div>
          <h2>Se quema la primera carta</h2>
          <p>Así se hace en cualquier mesa real, después de cortar.</p>
          <div class="cut-burned-card">${this.renderCards([this.burnedCardPreview])}</div>
          <button class="next-hand-btn" data-continue-after-cut type="button">Empezar a repartir</button>
        </div>
      `;
    } else {
      // Paso 1: elegir dónde cortar, deslizando la tarjeta roja.
      const pct = this.pendingCutPct ?? 0.5;
      this.root.innerHTML = `
        <div class="cut-ritual">
          <h2>Corta el zapato</h2>
          <p>Desliza la tarjeta roja hacia donde quieras cortar.</p>
          <div class="cut-deck" data-cut-deck>
            <div class="cut-deck-stack">
              ${Array.from({ length: 24 }, (_, i) => `<div class="cut-deck-card" style="left:${(i / 24) * 100}%"></div>`).join('')}
            </div>
            <div class="cut-marker" data-cut-marker style="left:${pct * 100}%"></div>
          </div>
          <div class="cut-hint" data-cut-hint>${totalCards} cartas — cortando al ${(pct * 100).toFixed(0)}%</div>
          <button class="next-hand-btn" data-confirm-cut type="button">Cortar aquí</button>
        </div>
      `;
    }

    this.wireCutRitualEvents();
    this.emitUpdate();
  }

  wireCutRitualEvents() {
    const deck = this.root.querySelector('[data-cut-deck]');
    const marker = this.root.querySelector('[data-cut-marker]');
    const hint = this.root.querySelector('[data-cut-hint]');
    if (deck && marker) {
      let dragging = false;

      const updateFromPointer = (e) => {
        const rect = deck.getBoundingClientRect();
        const raw = (e.clientX - rect.left) / rect.width;
        const pct = Math.min(Math.max(raw, 0.05), 0.95);
        this.pendingCutPct = pct;
        // Actualiza el DOM directamente (sin llamar a render()) para que
        // el arrastre se sienta fluido en vez de redibujar todo en cada
        // movimiento del dedo.
        marker.style.left = `${pct * 100}%`;
        if (hint) hint.textContent = `${this.game.pendingShoeCards?.totalCards ?? 0} cartas — cortando al ${(pct * 100).toFixed(0)}%`;
      };

      deck.addEventListener('pointerdown', (e) => {
        dragging = true;
        deck.setPointerCapture(e.pointerId);
        updateFromPointer(e);
      });
      deck.addEventListener('pointermove', (e) => {
        if (dragging) updateFromPointer(e);
      });
      deck.addEventListener('pointerup', () => { dragging = false; });
      deck.addEventListener('pointercancel', () => { dragging = false; });
    }
    const confirmBtn = this.root.querySelector('[data-confirm-cut]');
    if (confirmBtn) confirmBtn.addEventListener('click', () => this.confirmCut(this.pendingCutPct));
    const continueBtn = this.root.querySelector('[data-continue-after-cut]');
    if (continueBtn) continueBtn.addEventListener('click', () => this.continueAfterCut());
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
