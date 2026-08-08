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
import { handValue, isPastCutCard } from './deck.js';
import { basicStrategyAction, normalizeDealerUpcard } from './strategy.js';

// Roster de 10 bots — nombres variados, cada uno con su propio nivel de
// precisión (probabilidad de jugar la acción correcta de estrategia
// básica; el resto de las veces elige otra acción legal al azar, para
// simular jugadores reales con distinto nivel, no todos perfectos).
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BOT_ROSTER = [
  { name: 'Ada', precision: 0.95 },
  { name: 'Beto', precision: 0.60 },
  { name: 'Caro', precision: 0.85 },
  { name: 'Dani', precision: 0.70 },
  { name: 'Eli', precision: 0.90 },
  { name: 'Fabián', precision: 0.55 },
  { name: 'Gaby', precision: 0.75 },
  { name: 'Hugo', precision: 0.80 },
  { name: 'Inés', precision: 0.65 },
  { name: 'Jorge', precision: 0.50 },
];

/** Decisión de un bot: acierta según su propio nivel de precisión; si falla, elige otra acción legal al azar. Sin conteo de cartas. */
function botDecideAction(cards, dealerUpcardRank, legalActions, precision = 1) {
  const { total, isSoft } = handValue(cards);
  const isPair = cards.length === 2 && cards[0].rank === cards[1].rank;
  const handType = isPair ? 'pair' : (isSoft ? 'soft' : 'hard');
  const key = isPair
    ? (cards[0].rank === 'A' ? 'A' : normalizeDealerUpcard(cards[0].rank))
    : (isSoft ? total - 11 : total);
  let correctAction = basicStrategyAction(handType, key, dealerUpcardRank);
  if (!legalActions.includes(correctAction)) correctAction = legalActions.includes('hit') ? 'hit' : 'stand';

  if (Math.random() < precision) return correctAction;
  const alternatives = legalActions.filter(a => a !== correctAction);
  const pool = alternatives.length ? alternatives : legalActions;
  return pool[Math.floor(Math.random() * pool.length)];
}

const RESULT_LABELS = { win: 'WIN', blackjack: 'WIN', loss: 'LOSE', push: 'PUSH' };

export class BlackjackTableController {
  constructor({ root, playerName = '', initialBankroll = 1000, minimumBet = 20, maximumBet = 2000, onUpdate = () => {}, repository }) {
    this.root = root;
    this.playerName = playerName;
    this.onUpdate = onUpdate;
    if (!repository) throw new Error('BlackjackTableController requires a repository.');
    this.repository = repository;
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
    this.awaitingTableSetup = false;
    this.tableSetup = null; // { mode, position, botCount } — estado temporal mientras se elige
    this.tableMode = 'solo'; // 'solo' | 'multi' — se pregunta una vez por zapato
    this.tableOrder = []; // array ordenado por posición: [{ position, type: 'player'|'bot', slot?, botName?, hand }]
    this.tableOrderIndex = 0;
    this.playerPrimaryPosition = null; // puesto fijo del jugador en la mesa multi, para todo el zapato
    this.wantsSecondSeat = false; // se decide cada mano, no al configurar la mesa
    this.actionsLocked = false; // se ven las cartas, pero los botones esperan un momento antes de activarse
    this.botRosterPool = []; // bots del roster de 10 que no están sentados ahora mismo — candidatos para llenar una vacante
    this.vacantBotPositions = []; // posiciones donde un bot se retiró sin fichas — pueden llenarse con otro más adelante
    this.cutCardLandedOn = null; // etiqueta de quién recibió la carta de corte en esta mano (se anuncia, no interrumpe el reparto)
    this.botIsCutting = null; // nombre del bot que está cortando el zapato automáticamente, si le tocó a él
    this.lastError = null;
    this.lastHandResults = null;
    this.sessionStartedAt = null;
    this.decisionStartedAt = null;
    this.responseTimes = [];
    this.bestStreak = 0;
    this.sessionTotals = { totalHands: 0, correctDecisions: 0, incorrectDecisions: 0, totalProfit: 0, totalEvLoss: 0 };
    this.recentHistory = [];
    this.betEditorOpen = false;
    this.performancePanelOpen = false;
    this.viewportFitFrame = null;
    this.cardsInMotion = false;
    this.discardBacks = [];
  }

  async startSession() {
    this.session = await this.repository.createTrainingSession({
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
    this.game.shoeNumber = await this.repository.getShoeCountForSession(sessionRow.id);
  }

  /**
   * Arranca el ritual de corte: guarda el zapato anterior (si había),
   * baraja uno nuevo y lo deja pendiente de que el jugador elija dónde
   * cortar — la mesa muestra la pantalla de corte en vez de repartir.
   */
  async startCutRitual() {
    const designatedCutter = this.cutCardLandedOn; // quién debía cortar este zapato nuevo, según la mano anterior

    if (this.game.shoe && this.currentShoeRow) {
      await this.repository.saveShoe({
        id: this.currentShoeRow.id, sessionId: this.session.id, shoeNumber: this.game.shoeNumber,
        shoe: this.game.shoe, endedAt: new Date().toISOString(),
      });
    }
    beginShoeShuffle(this.game);
    this.discardBacks = [];
    this.awaitingCut = true;
    this.burnedCardPreview = null;
    this.cutCardLandedOn = null; // se vuelve a detectar para este zapato nuevo, cuando corresponda
    this.pendingCutPct = 0.5;

    if (designatedCutter && designatedCutter.type === 'bot') {
      // Le tocó la carta de corte a un bot en el zapato anterior — corta
      // él mismo, sin necesitar que el jugador arrastre nada.
      this.botIsCutting = designatedCutter.botName;
      this.render();
      const randomPct = 0.15 + Math.random() * 0.70; // un corte "humano" típico, no justo al centro
      await this.confirmCut(randomPct);
      this.botIsCutting = null;
      return;
    }

    this.render();
    await this.animateShoeToCutStage();
  }

  /** El jugador tocó un punto del mazo (0 a 1) para insertar la tarjeta roja. */
  async confirmCut(pct) {
    if (!this.game.pendingShoeCards || this.cutSequenceRunning) return;
    this.cutSequenceRunning = true;
    const clamped = Math.min(Math.max(pct, 0.05), 0.95); // no dejar cortar en el borde extremo
    const cutPosition = Math.floor(this.game.pendingShoeCards.totalCards * clamped);
    try {
      const burned = confirmShoeCut(this.game, cutPosition);
      this.burnedCardPreview = burned;
      this.pendingCutPct = null;

      // La animación representa exactamente las dos operaciones del motor:
      // primero el corte elegido por el jugador y luego la tarjeta roja en
      // la penetración aleatoria calculada para este zapato.
      await this.animateCutSequence(clamped, this.game.shoe.cutCardPosition);
      this.currentShoeRow = await this.repository.saveShoe({ sessionId: this.session.id, shoeNumber: this.game.shoeNumber, shoe: this.game.shoe });
      this.root.classList.remove('cut-shoe-empty', 'cut-sequence-running');
      this.render();
      await this.animateCardFromShoe('.cut-burned-card .card');
    } finally {
      this.cutSequenceRunning = false;
    }
  }

  /** El jugador ya vio la carta quemada — arranca el reparto normal del zapato nuevo. */
  async continueAfterCut() {
    await this.animateCardsToDiscard();
    await sleep(100);
    this.awaitingCut = false;
    this.burnedCardPreview = null;
    await this.dealNewHand();
  }

  /**
   * Avanza el turno de la mesa en orden real de posición: los puestos
   * de bots se juegan solos e instantáneo (estrategia básica correcta,
   * sin conteo); en cuanto le toca a un puesto del jugador humano que
   * todavía no está resuelto, se detiene ahí y espera su acción real.
   * Si ya no queda nadie pendiente, cierra la mano (casa + liquidación).
   */
  async advanceTableTurn() {
    while (this.tableOrderIndex < this.tableOrder.length) {
      const entry = this.tableOrder[this.tableOrderIndex];
      if (entry.type === 'bot') {
        await this.playBotHandFully(entry, entry.precision);
        this.tableOrderIndex++;
        await sleep(350 + Math.random() * 250);
        continue;
      }
      if (allPlayerHandsResolved(entry.hand)) {
        this.tableOrderIndex++;
        continue;
      }
      this.actionsLocked = true;
      this.render(); // ya se ven tus cartas, pero los botones esperan un momento antes de activarse
      await sleep(600);
      this.actionsLocked = false;
      this.render();
      return; // le toca a este puesto del jugador — se detiene y espera
    }
    await this.finishMultiTableHand();
  }

  /** Juega un puesto de bot carta por carta, con una pausa humana entre decisiones. */
  async playBotHandFully(entry, precision = 1) {
    const hand = entry?.hand;
    if (!hand || hand.naturalBlackjackResolved) return;
    if (hand.insurance?.offered) resolveInsurance(hand, false, 0); // los bots nunca cuentan cartas, siempre rechazan el seguro
    this.render(); // muestra inmediatamente quién está pensando antes de su pausa
    let guard = 0;
    while (!allPlayerHandsResolved(hand) && guard < 20) {
      const active = hand.playerHands[hand.activeHandIndex];
      if (!active || active.status !== 'active') break;
      const legal = availableActions(hand, 1000000);
      if (!legal.length) break;
      await sleep(550 + Math.random() * 500);
      const activeIndex = hand.activeHandIndex;
      const previousLength = active.cards.length;
      const action = botDecideAction(active.cards, hand.dealerUpcard, legal, precision);
      applyPlayerAction(this.game, hand, action);
      this.render();
      if (action === 'split') {
        await this.animateCardFromShoe(`[data-position="${entry.position}"] [data-hand-index="0"] .card:last-child`);
        await sleep(70);
        await this.animateCardFromShoe(`[data-position="${entry.position}"] [data-hand-index="1"] .card:last-child`);
      } else if (active.cards.length > previousLength) {
        await this.animateCardFromShoe(`[data-position="${entry.position}"] [data-hand-index="${activeIndex}"] .card:last-child`);
      }
      guard++;
    }
  }

  /** Cierra una mano de mesa multi-jugador: casa juega una vez, se liquidan los puestos del jugador (los de bots solo se resuelven, no se guardan). */
  async finishMultiTableHand() {
    try {
      playDealerHandMultiSeat(this.game, this.tableOrder.map(e => e.hand));

      for (const entry of this.tableOrder) {
        if (entry.type === 'player') {
          const seatNumber = entry.slot === 'hand' ? 1 : 2;
          const result = await this.settleOneSeat(entry.hand, seatNumber);
          if (entry.slot === 'hand') this.lastHandResults = result;
          else this.lastHandResults2 = result;
        } else {
          const { totalProfit } = resolveHandResults(entry.hand); // no se persiste ni cuenta para tus estadísticas, solo lleva su propio saldo
          entry.bankroll += totalProfit;
        }
      }

      if (!this.cutCardLandedOn) this.cutCardLandedOn = this.detectCutCardLanding();

      // Los bots que se quedaron sin fichas suficientes para la mínima se retiran — su puesto queda vacante.
      const leaving = this.tableOrder.filter(e => e.type === 'bot' && e.bankroll < this.minimumBet);
      if (leaving.length) {
        for (const entry of leaving) this.vacantBotPositions.push(entry.position);
        this.tableOrder = this.tableOrder.filter(e => !leaving.includes(e));
      }

      const totalPlayerProfit = (this.lastHandResults?.totalProfit || 0) + (this.lastHandResults2?.totalProfit || 0);
      updateStreak(this.game, totalPlayerProfit);
      this.bestStreak = Math.max(this.bestStreak, this.game.currentStreak);
      await this.repository.updateSessionTotals(this.session.id, this.sessionTotals);
      this.render();
      await this.animateDealerReveal();
    } catch (error) {
      console.error('finishMultiTableHand error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }
  showTableSetup() {
    this.awaitingTableSetup = true;
    this.tableSetup = { mode: null, position: null, botCount: null };
    this.render();
  }

  chooseTableMode(mode) {
    this.tableSetup.mode = mode;
    if (mode === 'solo') {
      this.tableMode = 'solo';
      this.tableOrder = [];
      this.awaitingTableSetup = false;
      this.tableSetup = null;
      this.startCutRitual(); // el corte viene después de decidir el modo, no el reparto directo
      return;
    }
    this.render();
  }

  /** Un solo puesto fijo para toda la sesión — jugar un segundo puesto se decide cada mano, no aquí. */
  choosePosition(position) {
    this.tableSetup.position = position;
    this.render();
  }

  chooseBotCount(count) {
    this.tableSetup.botCount = count;
    this.render();
  }

  /**
   * Si el zapato ya cruzó la carta de corte en esta mano, busca en qué
   * puesto cayó exactamente esa carta (por identidad, no por posición
   * visual) — solo para anunciarlo. No cambia nada del reparto: la
   * mano en curso ya se repartió y se termina igual, sin importar en
   * qué puesto haya caído. El próximo zapato se corta recién en la
   * siguiente mano (comportamiento que ya existía).
   */
  detectCutCardLanding() {
    const shoe = this.game.shoe;
    if (!shoe || !isPastCutCard(shoe)) return null;
    if (shoe.cutCardPosition >= shoe.dealtSequence.length) return null;
    const cutCard = shoe.dealtSequence[shoe.cutCardPosition];
    if (!cutCard) return null;

    const seats = [];
    if (this.tableMode === 'multi' && this.tableOrder.length > 0) {
      this.tableOrder.forEach((entry) => {
        if (!entry.hand) return;
        seats.push({
          type: entry.type, // 'player' | 'bot'
          label: entry.type === 'player' ? `Tú (Puesto ${entry.position})` : `${entry.botName} (Puesto ${entry.position})`,
          botName: entry.type === 'bot' ? entry.botName : null,
          cards: entry.hand.playerHands.flatMap(h => h.cards),
        });
      });
      const dealerCards = this.tableOrder[0]?.hand?.dealerCards ?? [];
      seats.push({ type: 'dealer', label: 'la casa', botName: null, cards: dealerCards });
    } else {
      if (this.hand) seats.push({ type: 'player', label: 'Puesto 1', botName: null, cards: this.hand.playerHands.flatMap(h => h.cards) });
      if (this.hand2) seats.push({ type: 'player', label: 'Puesto 2', botName: null, cards: this.hand2.playerHands.flatMap(h => h.cards) });
      seats.push({ type: 'dealer', label: 'la casa', botName: null, cards: this.hand?.dealerCards ?? [] });
    }

    const owner = seats.find(s => s.cards.some(c => c.id === cutCard.id));
    if (!owner) return null;
    return { type: owner.type, label: owner.label, botName: owner.botName };
  }

  /**
   * "Puede pasar tiempo y entrar otro jugador": cada vez que se va a
   * repartir, si hay un puesto vacante (un bot se retiró sin fichas) y
   * todavía quedan bots disponibles en el roster de 10, hay una
   * probabilidad (no es instantáneo) de que uno nuevo se siente ahí.
   */
  tryFillVacantSeat() {
    if (!this.vacantBotPositions.length || !this.botRosterPool.length) return;
    if (Math.random() > 0.20) return; // ~20% de probabilidad por mano de que entre alguien nuevo

    const position = this.vacantBotPositions.shift();
    const newBot = this.botRosterPool.shift();
    this.tableOrder.push({
      position, type: 'bot', hand: null,
      botName: newBot.name, precision: newBot.precision,
      bankroll: this.minimumBet * 25,
    });
    this.tableOrder.sort((a, b) => a.position - b.position);
  }

  async confirmTableSetupAndDeal() {
    const { position, botCount } = this.tableSetup;
    this.tableMode = 'multi';
    this.playerPrimaryPosition = position; // el puesto fijo del jugador para todo este zapato
    const availableForBots = [1, 2, 3, 4, 5, 6].filter(p => p !== position);
    const botPositions = availableForBots.slice(0, botCount);

    const shuffledRoster = BOT_ROSTER.slice().sort(() => Math.random() - 0.5);
    const chosenBots = shuffledRoster.slice(0, botPositions.length);
    this.botRosterPool = shuffledRoster.slice(botPositions.length); // el resto queda disponible para reemplazos futuros

    const order = [{ position, type: 'player', slot: 'hand', hand: null }];
    botPositions.forEach((p, i) => order.push({
      position: p, type: 'bot', hand: null,
      botName: chosenBots[i].name, precision: chosenBots[i].precision,
      bankroll: this.minimumBet * 25, // fichas de arranque del bot
    }));
    order.sort((a, b) => a.position - b.position);
    this.tableOrder = order;
    this.hand2 = null; // el segundo puesto (si se juega) se decide mano a mano, no aquí
    this.awaitingTableSetup = false;
    this.tableSetup = null;
    await this.startCutRitual(); // el corte del zapato viene después de configurar la mesa
  }

  /** Elige 1 o 2 puestos Y reparte la próxima mano en el mismo toque — un solo tap, sin ventana de tiempo entre elegir y repartir. */
  async chooseSeatCountAndDeal(count) {
    if (this.currentActiveTarget()) return; // protección extra: nunca cambiar mientras hay una mano sin terminar
    if (this.tableMode === 'multi') {
      this.wantsSecondSeat = count === 2;
    } else {
      this.seat2Open = count === 2;
      if (!this.seat2Open) this.hand2 = null;
    }
    await this.dealNewHand();
  }

  /** El puesto libre justo antes o después del tuyo — el único lugar donde tendría sentido jugar un segundo puesto en la mesa real. null si ambos están ocupados. */
  findAdjacentFreePosition() {
    const p = this.playerPrimaryPosition;
    if (!p) return null;
    const occupied = new Set(this.tableOrder.map(e => e.position));
    const next = p === 6 ? 1 : p + 1;
    const prev = p === 1 ? 6 : p - 1;
    if (!occupied.has(next)) return next;
    if (!occupied.has(prev)) return prev;
    return null;
  }

  /** ¿Ya se resolvieron todos los puestos que tienen mano repartida en esta ronda? */
  bothSeatsResolved() {
    if (this.tableMode === 'multi' && this.tableOrder.length > 0) {
      return this.tableOrder.every(e => e.hand && allPlayerHandsResolved(e.hand));
    }
    const seat1Done = !this.hand || allPlayerHandsResolved(this.hand);
    const seat2Done = !this.hand2 || allPlayerHandsResolved(this.hand2);
    return seat1Done && seat2Done;
  }

  /** ¿Cuál puesto le toca jugar ahora mismo? 'hand', 'hand2', o null si ya no hay nada pendiente. */
  currentActiveTarget() {
    if (this.tableMode === 'multi' && this.tableOrder.length > 0) {
      const entry = this.tableOrder[this.tableOrderIndex];
      if (entry && entry.type === 'player' && !allPlayerHandsResolved(entry.hand)) return entry.slot;
      return null;
    }
    if (this.hand && !allPlayerHandsResolved(this.hand)) return 'hand';
    if (this.hand2 && !allPlayerHandsResolved(this.hand2)) return 'hand2';
    return null;
  }

  async dealNewHand() {
    try {
      // Las cartas resueltas permanecen sobre el fieltro para poder ver el
      // resultado. Se recogen únicamente cuando ya va a comenzar el reparto
      // siguiente.
      if (this.lastHandResults) {
        await this.animateCardsToDiscard();
        await sleep(110);
      }
      this.lastError = null;
      this.lastHandResults = null;
      this.lastHandResults2 = null;

      if (shoeNeedsReplacement(this.game)) {
        this.showTableSetup();
        return; // el corte del zapato viene DESPUÉS de configurar la mesa (startCutRitual, llamado desde el flujo de configuración)
      }

      if (this.tableMode === 'multi' && this.tableOrder.length > 0) {
        // El segundo puesto anterior permanece visible durante el resultado y
        // se retira recién al comenzar la próxima mano.
        this.tableOrder = this.tableOrder.filter(entry => !entry.temporary);
        this.hand2 = null; // se vuelve a asignar más abajo solo si se juega un segundo puesto esta mano
        this.tryFillVacantSeat(); // antes de repartir: puede que un bot nuevo entre en un puesto que quedó vacío

        // Jugar un segundo puesto se decide cada mano (no al configurar la
        // mesa) — solo es posible si el puesto justo antes o después del
        // tuyo está libre en este momento.
        if (this.wantsSecondSeat) {
          const adjacent = this.findAdjacentFreePosition();
          if (adjacent) {
            this.tableOrder.push({ position: adjacent, type: 'player', slot: 'hand2', hand: null, temporary: true });
            this.tableOrder.sort((a, b) => a.position - b.position);
          } else {
            this.wantsSecondSeat = false; // no hay dónde — se juega solo el puesto propio esta mano
          }
        }

        const totalOwnStake = this.tableOrder
          .filter(e => e.type === 'player')
          .reduce((s, e) => s + (e.slot === 'hand' ? this.currentBet : this.currentBet2), 0);
        if (totalOwnStake > this.bankroll) throw new Error('Saldo insuficiente. Compra más fichas o baja tu apuesta.');

        const seatConfigs = this.tableOrder.map((entry) => {
          if (entry.type === 'player') {
            const bet = entry.slot === 'hand' ? this.currentBet : this.currentBet2;
            const prevHand = entry.slot === 'hand' ? this.hand : this.hand2;
            return { betAmount: bet, bankrollBeforeHand: this.bankroll, previousBetAmount: prevHand?.playerHands?.[0]?.bet ?? null };
          }
          const bet = Math.min(this.minimumBet, entry.bankroll);
          return { betAmount: bet, bankrollBeforeHand: entry.bankroll, previousBetAmount: null };
        });

        const hands = dealMultiSeatRound(this.game, seatConfigs);
        this.tableOrder.forEach((entry, i) => {
          entry.hand = hands[i];
          if (entry.type === 'player') this[entry.slot] = hands[i];
          // v1: con varios puestos en la mesa (propios o de otros
          // jugadores) el seguro se rechaza automáticamente — preguntarlo
          // por separado a cada puesto queda para una siguiente iteración.
          if (entry.type === 'player' && entry.hand.insurance?.offered) {
            resolveInsurance(entry.hand, false, 0);
          }
        });
        this.tableOrderIndex = 0;
        this.actionsLocked = true;
        this.render();
        await this.animateInitialDeal();
        this.actionsLocked = false;
        await this.advanceTableTurn();
        return;
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
        this.actionsLocked = true;
        this.render();
        await this.animateInitialDeal();
        this.actionsLocked = false;
        this.render();
        if (this.bothSeatsResolved()) await this.finishHand();
      } else {
        this.hand = dealInitialRound(this.game, { betAmount: this.currentBet, bankrollBeforeHand: this.bankroll, previousBetAmount: previousBet });
        this.hand2 = null;
        this.actionsLocked = true;
        this.render();
        await this.animateInitialDeal();
        this.actionsLocked = false;
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
      const activeIndex = hand.activeHandIndex;
      const previousLength = hand.playerHands[activeIndex]?.cards.length ?? 0;
      applyPlayerAction(this.game, hand, action);
      this.actionsLocked = true;
      this.render();
      if (action === 'split') {
        await this.animateCardFromShoe(`[data-player-slot="${target}"][data-hand-index="0"] .card:last-child`);
        await sleep(70);
        await this.animateCardFromShoe(`[data-player-slot="${target}"][data-hand-index="1"] .card:last-child`);
      } else if ((hand.playerHands[activeIndex]?.cards.length ?? 0) > previousLength) {
        await this.animateCardFromShoe(`[data-player-slot="${target}"][data-hand-index="${activeIndex}"] .card:last-child`);
      }
      this.actionsLocked = false;
      this.render();

      if (this.tableMode === 'multi' && this.tableOrder.length > 0) {
        if (allPlayerHandsResolved(hand)) {
          this.tableOrderIndex++;
          await this.advanceTableTurn();
        }
      } else if (this.bothSeatsResolved()) {
        await this.finishHand();
      }
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

    await this.repository.saveResolvedHand({
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

    handResults.forEach((result, handIndex) => {
      const decisions = hand.decisions.filter(decision => decision.playerHandIndex === handIndex);
      const firstDecision = decisions[0] ?? null;
      const lastDecision = decisions[decisions.length - 1] ?? null;
      const finalTotal = handValue(result.cards).total;
      this.recentHistory.unshift({
        handType: firstDecision?.handType ?? (result.result === 'blackjack' ? 'blackjack' : 'hard'),
        playerTotal: firstDecision?.playerTotal ?? finalTotal,
        dealerUpcard: hand.dealerUpcard,
        action: lastDecision?.playerAction ?? null,
        result: result.result,
        profit: result.profit,
        seatNumber,
      });
    });
    this.recentHistory = this.recentHistory.slice(0, 5);

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
      if (!this.cutCardLandedOn) this.cutCardLandedOn = this.detectCutCardLanding();
      await this.repository.updateSessionTotals(this.session.id, this.sessionTotals);
      this.render();
      await this.animateDealerReveal();
    } catch (error) {
      console.error('finishHand error:', error);
      this.lastError = error?.message || String(error);
      this.render();
    }
  }

  async endSession() {
    if (this.session) await this.repository.endTrainingSession(this.session.id, this.bankroll);
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

  /** Herramienta exclusiva del preview local: acerca la carta de corte sin alterar el orden del mazo. */
  setCardsUntilCutForTesting(count) {
    const shoe = this.game.shoe;
    if (!shoe) return false;
    const cardsUntilCut = Math.max(0, Math.floor(Number(count)));
    shoe.cutCardPosition = Math.min(shoe.totalCards, shoe.dealtSequence.length + cardsUntilCut);
    shoe.penetrationPct = Math.round((shoe.cutCardPosition / shoe.totalCards) * 1000) / 10;
    this.cutCardLandedOn = null;
    this.render();
    return true;
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

  renderTableAccessories() {
    const shoe = this.game.shoe;
    const dealt = shoe?.dealtSequence?.length ?? 0;
    const cardsUntilCut = shoe ? shoe.cutCardPosition - dealt : Number.POSITIVE_INFINITY;
    const shoeBacks = ['blue', 'blue', 'blue'];
    if (cardsUntilCut >= 0 && cardsUntilCut <= 2) shoeBacks[2 - cardsUntilCut] = 'red';
    const visibleDiscard = this.discardBacks.slice(-3);
    return `
      <div class="table-card-pile discard-pile" data-discard-pile aria-label="Pila de descarte: ${this.discardBacks.length} ${this.discardBacks.length === 1 ? 'carta' : 'cartas'}">
        <span class="pile-drop-target"></span>
        <div class="pile-stack" data-discard-stack>${visibleDiscard.map((back, index) => `<span class="pile-card-back ${back}-back" style="--pile-depth:${visibleDiscard.length - index - 1}"></span>`).join('')}</div>
        <small>DESCARTE</small>
      </div>
      <div class="table-card-pile shoe-pile" data-shoe-pile aria-label="Zapato">
        <div class="pile-stack">${shoeBacks.map((back, index) => `<span class="pile-card-back ${back}-back" style="--pile-depth:${shoeBacks.length - index - 1}"></span>`).join('')}</div>
        <small>${cardsUntilCut === 0 ? 'CORTE' : cardsUntilCut > 0 && cardsUntilCut <= 2 ? `CORTE EN ${cardsUntilCut}` : 'ZAPATO'}</small>
      </div>`;
  }

  renderFeltRules() {
    return `
      <div class="felt-watermark">
        <svg class="felt-rules-art" viewBox="0 0 480 190" role="img" aria-label="Reglas de la mesa">
          <defs>
            <path id="ruleArcMain" d="M 70 42 Q 240 94 410 42" />
            <path id="ruleArcSub" d="M 86 61 Q 240 105 394 61" />
            <path id="ruleArcBottom" d="M 102 87 Q 240 127 378 87" />
          </defs>
          <path class="rule-accent-line rule-accent-top" d="M 95 24 Q 240 73 385 24" />
          <path class="rule-accent-line rule-accent-middle" d="M 86 68 Q 240 112 394 68" />
          <path class="rule-accent-line rule-accent-bottom" d="M 124 102 Q 240 130 356 102" />
          <text class="rule-title"><textPath href="#ruleArcMain" startOffset="50%" text-anchor="middle">BLACKJACK PAGA 3 A 2</textPath></text>
          <text class="rule-sub"><textPath href="#ruleArcSub" startOffset="50%" text-anchor="middle">EL DEALER PIDE EN 16 Y SE PLANTA EN 17</textPath></text>
          <text class="rule-bottom"><textPath href="#ruleArcBottom" startOffset="50%" text-anchor="middle">EL SEGURO PAGA 2 A 1</textPath></text>
        </svg>
      </div>`;
  }

  // --- Renderizado ---

  render() {
    if (!this.root) return;
    this.root.classList.toggle('multi-table', this.tableMode === 'multi');

    if (this.awaitingCut) {
      this.renderCutRitual();
      return;
    }

    if (this.awaitingTableSetup) {
      this.renderTableSetup();
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
    const legal = (activeHandObj && !insurancePending && !this.actionsLocked)
      ? availableActions(activeHandObj, this.bankroll - this.currentActiveHandsCommitted())
      : [];

    const streak = this.game.currentStreak;
    const dealerTotal = dealerVisible.length ? handValue(dealerVisible).total : 0;
    const results = this.lastHandResults?.handResults ?? null;
    const results2 = this.lastHandResults2?.handResults ?? null;
    const hasSecondOwnSeat = this.tableMode === 'multi' ? this.wantsSecondSeat : this.seat2Open;
    const bothResultsReady = Boolean(this.lastHandResults && (!hasSecondOwnSeat || this.lastHandResults2));
    const insuranceProfit = this.lastHandResults?.insuranceProfit ?? 0;
    const activeHand = this.hand ? (this.hand.playerHands[this.hand.activeHandIndex] ?? this.hand.playerHands[0]) : null;
    const profitPct = this.profitPct();
    const latestResult = results?.[0] ?? null;
    const latestProfit = this.lastHandResults?.totalProfit ?? null;
    const latestEvLoss = this.hand?.decisions?.reduce((sum, decision) => sum + (decision.evLoss || 0), 0) ?? 0;

    this.root.innerHTML = this.hand ? `
      ${this.renderTableAccessories()}
      ${this.renderFeltRules()}

      <div class="seat">
        <div class="seat-label">Dealer</div>
        <div class="seat-row">
          <div class="card-row dealer-cards" data-dealer-cards>${this.renderCards(dealerVisible)}${!resolved ? this.renderFaceDownCard(this.hand.dealerCards[1]) : ''}</div>
          <div class="total-pill">${dealerTotal}</div>
        </div>
      </div>

      ${this.tableMode === 'multi' ? this.renderSixSeatGrid(activeTarget, results, results2, insuranceProfit) : `
      <div class="seats-row">
        <div class="seat ${activeTarget === 'hand' ? 'current-player' : ''}">
          <div class="seat-label">${this.seat2Open ? 'Puesto 1' : 'Tú'}</div>
          <div class="hands-row">
            ${this.hand.playerHands.map((h, i) => {
              const r = results ? results[i] : null;
              const cls = r ? r.result : (i === this.hand.activeHandIndex && activeTarget === 'hand' ? 'active' : '');
              return `
                <div class="hand-slot ${cls}" data-player-slot="hand" data-hand-index="${i}">
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
          <div class="seat ${activeTarget === 'hand2' ? 'current-player' : ''}">
            <div class="seat-label">Puesto 2</div>
            <div class="hands-row">
              ${this.hand2.playerHands.map((h, i) => {
                const r2 = results2 ? results2[i] : null;
                const cls = r2 ? r2.result : (i === this.hand2.activeHandIndex && activeTarget === 'hand2' ? 'active' : '');
                return `
                  <div class="hand-slot ${cls}" data-player-slot="hand2" data-hand-index="${i}">
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
      `}

      <div class="dock">
        ${this.cutCardLandedOn ? `<div class="cut-card-banner">🔴 Salió la carta de corte en ${this.cutCardLandedOn.label} — ${this.cutCardLandedOn.type === 'bot' ? `${this.cutCardLandedOn.botName} cortará el próximo zapato.` : 'el próximo zapato se corta después de esta mano.'}</div>` : ''}
        ${this.lastError ? `<div class="error-toast">${this.escapeHtml(this.lastError)}</div>` : ''}

        ${this.renderBottomHandTotals(activeTarget)}
        <div class="wager-control">
          <span class="chip-icon wager-chip"><span class="chip-glyph">♛</span></span>
          <div class="wager-copy"><small>APUESTA</small><strong>$${this.currentBet.toFixed(2)}</strong></div>
          <button class="wager-change-btn" data-toggle-bet-editor type="button">${this.betEditorOpen ? 'ACEPTAR' : 'CAMBIAR'}</button>
        </div>
        <div class="bet-editor ${this.betEditorOpen ? 'open' : ''}" data-bet-editor>
          <div class="bet-editor-inner">
            ${this.seat2Open || this.hand2 ? `<div class="quick-bets-label">Puesto 1</div>` : ''}
            <div class="quick-bets">
              <button data-bet-delta="-10" type="button">-10</button>
              <button data-bet-delta="-1" type="button">-1</button>
              <button data-bet-pct="0.5" type="button">50%</button>
              <button data-bet-delta="1" type="button">+1</button>
              <button data-bet-delta="10" type="button">+10</button>
            </div>
            ${this.seat2Open || this.hand2 ? `
              <div class="quick-bets-label">Puesto 2</div>
              <div class="quick-bets">
                <button data-bet-delta2="-10" type="button">-10</button>
                <button data-bet-delta2="-1" type="button">-1</button>
                <button data-bet-pct2="0.5" type="button">50%</button>
                <button data-bet-delta2="1" type="button">+1</button>
                <button data-bet-delta2="10" type="button">+10</button>
              </div>
            ` : ''}
          </div>
        </div>

        ${this.lastError && !legal.length && !(resolved && bothResultsReady) ? `
          <button class="next-hand-btn" data-retry-deal type="button">Reintentar</button>
        ` : resolved && bothResultsReady ? (() => {
          const isMulti = this.tableMode === 'multi';
          const selected1 = isMulti ? !this.wantsSecondSeat : !this.seat2Open;
          const selected2 = isMulti ? this.wantsSecondSeat : this.seat2Open;
          const secondSeatAvailable = !isMulti || Boolean(this.findAdjacentFreePosition());
          return `
          <div class="seat-count-picker">
            <span class="seat-count-label">Siguiente mano:</span>
            <button class="seat-count-btn ${selected1 ? 'selected' : ''}" data-seat-count="1" type="button">1 puesto</button>
            <button class="seat-count-btn ${selected2 ? 'selected' : ''}" data-seat-count="2" type="button" ${secondSeatAvailable ? '' : 'disabled'}>2 puestos</button>
          </div>
          ${isMulti ? `<div class="cut-hint">Puesto ${this.playerPrimaryPosition} · mesa de ${this.tableOrder.length} jugadores</div>` : ''}
          `;
        })() : `
          ${this.actionsLocked ? `<div class="cut-hint">Un momento, revisa tus cartas…</div>` : ''}
          <div class="action-row">
            <button class="action-btn double" data-action="double" ${legal.includes('double') ? '' : 'disabled'}><span class="icon">2x</span>DOBLAR</button>
            <button class="action-btn hit" data-action="hit" ${legal.includes('hit') ? '' : 'disabled'}><span class="icon">＋</span>PEDIR</button>
            <button class="action-btn stand" data-action="stand" ${legal.includes('stand') ? '' : 'disabled'}><span class="icon">−</span>PLANTARSE</button>
            <button class="action-btn split" data-action="split" ${legal.includes('split') ? '' : 'disabled'}><span class="icon">⇄</span>DIVIDIR</button>
            <button class="action-btn insurance" type="button" disabled title="El seguro se pregunta automáticamente"><span class="icon">🛡</span>SEGURO</button>
          </div>
        `}

        <div class="performance-dashboard ${this.performancePanelOpen ? 'open' : 'collapsed'}" data-performance-dashboard>
        <button class="performance-toggle" data-toggle-performance type="button" aria-label="${this.performancePanelOpen ? 'Ocultar resumen' : 'Mostrar resumen'}" aria-expanded="${this.performancePanelOpen}">
          <span>${this.performancePanelOpen ? '⌄' : '⌃'}</span>
        </button>
        <div class="performance-content" data-performance-content>
        <div class="summary-panel">
          <div class="col"><div class="s-label">Saldo</div><div class="s-value">$${this.bankroll.toFixed(2)}</div></div>
          <div class="col">
            <div class="s-label">Rendimiento</div>
            <div class="s-value green">${profitPct > 0 ? '+' : ''}${profitPct}%</div>
            <div class="s-sub">${(this.bankroll - this.bankrollStart) >= 0 ? '+' : ''}$${(this.bankroll - this.bankrollStart).toFixed(2)}</div>
          </div>
        </div>

        <div class="hud-lower-grid">
          <section class="hand-result-card">
            <h3>RESULTADO DE LA MANO</h3>
            <div><span>Resultado</span><strong>${latestResult ? (RESULT_LABELS[latestResult.result] || latestResult.result.toUpperCase()) : '—'}</strong></div>
            <div><span>Ganancia / Pérdida</span><strong class="${latestProfit > 0 ? 'positive' : latestProfit < 0 ? 'negative' : ''}">${latestProfit === null ? '—' : `${latestProfit > 0 ? '+' : ''}$${latestProfit.toFixed(2)}`}</strong></div>
            <div><span>EV de la mano</span><strong>${this.hand ? latestEvLoss.toFixed(2) : '—'}</strong></div>
          </section>
          <section class="recent-history-card">
            <div class="panel-heading"><h3>HISTORIAL RECIENTE</h3><span>ÚLTIMAS 5</span></div>
            ${this.renderRecentHistory()}
          </section>
        </div>
        </div>
        </div>

      </div>
    ` : '';

    this.wireEvents();
    this.emitUpdate();
    this.scheduleViewportFit();
  }

  scheduleViewportFit() {
    if (this.viewportFitFrame) cancelAnimationFrame(this.viewportFitFrame);
    this.viewportFitFrame = requestAnimationFrame(() => {
      const screen = this.root?.closest('.table-screen');
      if (!screen) return;

      // Keep the layout tied to the real viewport. The previous fitter widened
      // the screen and depended on non-standard CSS `zoom` to shrink it back.
      // Mobile browsers apply that combination inconsistently, which left a
      // 480px+ table clipped inside a narrower phone viewport.
      screen.style.removeProperty('zoom');
      screen.style.removeProperty('width');
      screen.style.removeProperty('max-width');
      screen.style.removeProperty('--table-scale');
    });
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
      bankroll: this.bankroll,
      totalEvLoss: this.sessionTotals.totalEvLoss,
    });
  }

  wireEvents() {
    const performanceDashboard = this.root.querySelector('[data-performance-dashboard]');
    const performanceToggle = this.root.querySelector('[data-toggle-performance]');
    if (performanceDashboard && performanceToggle) {
      performanceToggle.addEventListener('click', () => {
        this.performancePanelOpen = !this.performancePanelOpen;
        performanceDashboard.classList.toggle('open', this.performancePanelOpen);
        performanceDashboard.classList.toggle('collapsed', !this.performancePanelOpen);
        performanceToggle.querySelector('span').textContent = this.performancePanelOpen ? '⌄' : '⌃';
        performanceToggle.setAttribute('aria-expanded', String(this.performancePanelOpen));
        performanceToggle.setAttribute('aria-label', this.performancePanelOpen ? 'Ocultar resumen' : 'Mostrar resumen');
      });
    }
    const betToggle = this.root.querySelector('[data-toggle-bet-editor]');
    const betEditor = this.root.querySelector('[data-bet-editor]');
    if (betToggle && betEditor) {
      betToggle.addEventListener('click', () => {
        this.betEditorOpen = !this.betEditorOpen;
        betEditor.classList.toggle('open', this.betEditorOpen);
        betToggle.textContent = this.betEditorOpen ? 'ACEPTAR' : 'CAMBIAR';
        this.scheduleViewportFit();
        setTimeout(() => this.scheduleViewportFit(), 320);
      });
    }
    this.root.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => this.playerAction(btn.dataset.action)));
    const nextBtn = this.root.querySelector('[data-next-hand]');
    if (nextBtn) nextBtn.addEventListener('click', () => this.dealNewHand());
    const nextBtnMulti = this.root.querySelector('[data-next-hand-multi]');
    if (nextBtnMulti) nextBtnMulti.addEventListener('click', () => this.dealNewHand());
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

  renderTableSetup() {
    const s = this.tableSetup;
    let inner = '';

    if (s.mode === null) {
      inner = `
        <h2>¿Jugar solo o con jugadores?</h2>
        <p>Se pregunta una vez por zapato.</p>
        <div class="table-setup-choices">
          <button class="next-hand-btn" data-table-mode="solo" type="button">Solo</button>
          <button class="next-hand-btn secondary" data-table-mode="multi" type="button">Con jugadores</button>
        </div>
      `;
    } else if (s.position === null) {
      inner = `
        <h2>Elige tu lugar en la mesa</h2>
        <p>Toca directamente una posición vacía de la mesa.</p>
      `;
    } else if (s.botCount === null) {
      const maxBots = 5; // los otros 5 puestos, además del tuyo
      inner = `
        <h2>¿Cuántos jugadores quieres en la mesa?</h2>
        <p>Los jugadores simulados ocuparán las posiciones libres.</p>
        <div class="table-setup-choices wrap">
          ${Array.from({ length: maxBots }, (_, i) => i + 1).map(n => `
            <button class="next-hand-btn secondary" data-bot-count="${n}" type="button">${n}</button>
          `).join('')}
        </div>
      `;
    } else {
      inner = `
        <h2>Mesa lista</h2>
        <p>Tu posición: ${s.position} · ${s.botCount} jugador${s.botCount > 1 ? 'es' : ''} adicional${s.botCount > 1 ? 'es' : ''}.</p>
        <button class="next-hand-btn" data-confirm-table-setup type="button">Continuar</button>
      `;
    }

    const positionPicker = s.mode === 'multi' && s.position === null;
    this.root.innerHTML = `
      ${this.renderTableAccessories()}
      ${this.renderFeltRules()}
      ${this.renderSetupTableScene(positionPicker)}
      <div class="table-flow-overlay ${positionPicker ? 'seat-pick-copy' : ''}"><div class="cut-ritual">${inner}</div></div>`;
    this.wireTableSetupEvents();
    this.emitUpdate();
  }

  renderSetupTableScene(clickable = false) {
    const chosenPosition = this.tableSetup?.position;
    const rows = [[6, 1], [5, 2], [4, 3]];
    const seats = rows.map(([left, right]) => `<div class="table-seats-row">
      ${[left, right].map(position => {
        const selected = position === chosenPosition;
        const contents = `<span class="setup-seat-number">${position}</span><span>${selected ? 'TÚ' : 'VACÍO'}</span>`;
        return clickable
          ? `<button class="setup-table-seat" data-choose-position="${position}" type="button" aria-label="Elegir posición ${position}">${contents}</button>`
          : `<div class="setup-table-seat ${selected ? 'selected' : ''}">${contents}</div>`;
      }).join('')}
    </div>`).join('');
    return `
      <div class="setup-table-scene" aria-hidden="${clickable ? 'false' : 'true'}">
        <div class="setup-dealer-plate">DEALER</div>
        <div class="table-seats-diamond setup-seat-diamond">${seats}</div>
      </div>`;
  }

  wireTableSetupEvents() {
    this.root.querySelectorAll('[data-table-mode]').forEach(btn =>
      btn.addEventListener('click', () => this.chooseTableMode(btn.dataset.tableMode)));
    this.root.querySelectorAll('[data-choose-position]').forEach(btn =>
      btn.addEventListener('click', () => this.choosePosition(Number(btn.dataset.choosePosition))));
    this.root.querySelectorAll('[data-bot-count]').forEach(btn =>
      btn.addEventListener('click', () => this.chooseBotCount(Number(btn.dataset.botCount))));
    const confirmBtn = this.root.querySelector('[data-confirm-table-setup]');
    if (confirmBtn) confirmBtn.addEventListener('click', () => this.confirmTableSetupAndDeal());
  }

  renderCutRitual() {
    const totalCards = this.game.pendingShoeCards?.totalCards ?? 0;

    if (this.botIsCutting) {
      // El bot al que le tocó la carta de corte del zapato anterior corta él mismo.
      this.root.innerHTML = this.renderTableFlowScreen(`
        <div class="cut-ritual">
          <div class="cut-ritual-icon">🤖</div>
          <h2>${this.botIsCutting} está cortando el zapato</h2>
          <p>Le tocó la carta de corte la mano pasada — le toca cortar a él.</p>
        </div>`);
    } else if (this.burnedCardPreview) {
      // Paso 2: ya se cortó — mostrar la carta quemada.
      this.root.innerHTML = this.renderTableFlowScreen(`
        <div class="cut-ritual">
          <div class="cut-ritual-icon">🔥</div>
          <h2>Se quema la primera carta</h2>
          <p>Así se hace en cualquier mesa real, después de cortar.</p>
          <div class="cut-burned-card">${this.renderCards([this.burnedCardPreview])}</div>
          <button class="next-hand-btn" data-continue-after-cut type="button">Empezar a repartir</button>
        </div>`, 'burn-flow');
    } else {
      // Paso 1: el zapato completo sale a la mesa. La tarjeta que queda
      // debajo del dedo se vuelve roja, sin mostrar un slider artificial.
      const pct = this.pendingCutPct ?? 0.5;
      const cardCount = Math.max(totalCards, 1);
      const selectedIndex = Math.round(pct * (cardCount - 1));
      const visualCards = Array.from({ length: cardCount }, (_, index) => {
        const x = cardCount === 1 ? 139 : (index / (cardCount - 1)) * 278;
        return `<span class="cut-spread-card blue-back"
          data-cut-card-index="${index}" style="--cut-x:${x.toFixed(2)}px;--cut-index:${index}"></span>`;
      }).join('');
      this.root.innerHTML = this.renderTableFlowScreen(`
        <div class="cut-ritual cut-ritual-floating">
          <div class="cut-ritual-icon">✂️</div>
          <h2>Corta el zapato</h2>
          <p>Desliza sobre las cartas y deja la tarjeta roja donde quieras cortar.</p>
          <div class="physical-cut-stage is-locked" data-cut-deck data-card-count="${cardCount}" aria-label="Zapato de ${totalCards} cartas. Desliza para elegir el corte.">
            <div class="cut-card-spread" data-cut-spread data-initial-cut-index="${selectedIndex}">${visualCards}</div>
          </div>
          <div class="cut-hint" data-cut-hint>${totalCards} cartas — cortando al ${(pct * 100).toFixed(0)}%</div>
          <button class="next-hand-btn" data-confirm-cut type="button" disabled>Cortar aquí</button>
        </div>`, 'cut-flow');
    }

    this.wireCutRitualEvents();
    this.emitUpdate();
    this.scheduleViewportFit();
  }

  renderTableFlowScreen(content, modifier = '') {
    return `
      ${this.renderTableAccessories()}
      ${this.renderFeltRules()}
      ${this.renderRitualTableScene()}
      <div class="table-flow-overlay ${modifier}">${content}</div>`;
  }

  renderRitualTableScene() {
    const rows = [[6, 1], [5, 2], [4, 3]];
    const seats = rows.map(([left, right]) => `<div class="table-seats-row">
      ${[left, right].map(position => {
        const entry = this.tableOrder.find(item => item.position === position);
        const label = entry ? (entry.type === 'player' ? 'TÚ' : entry.botName) : 'VACÍO';
        return `<div class="setup-table-seat ${entry ? 'occupied' : ''}"><span class="setup-seat-number">${position}</span><span>${this.escapeHtml(label)}</span></div>`;
      }).join('')}
    </div>`).join('');
    return `<div class="setup-table-scene ritual-table-scene" aria-hidden="true"><div class="setup-dealer-plate">DEALER</div><div class="table-seats-diamond setup-seat-diamond">${seats}</div></div>`;
  }

  wireCutRitualEvents() {
    const deck = this.root.querySelector('[data-cut-deck]');
    const cards = deck ? [...deck.querySelectorAll('[data-cut-card-index]')] : [];
    const hint = this.root.querySelector('[data-cut-hint]');
    if (deck && cards.length) {
      let dragging = false;
      let selectedCard = deck.querySelector('.is-cut-marker');

      const updateFromPointer = (e) => {
        const rect = deck.getBoundingClientRect();
        const raw = (e.clientX - rect.left) / rect.width;
        const pct = Math.min(Math.max(raw, 0.05), 0.95);
        const selectedIndex = Math.round(pct * (cards.length - 1));
        this.pendingCutPct = selectedIndex / Math.max(cards.length - 1, 1);

        // Solo la carta que está debajo del dedo cambia a roja. Se actualiza
        // directamente para que 312 cartas sigan el arrastre sin re-render.
        selectedCard ||= deck.querySelector('.is-cut-marker');
        if (selectedCard !== cards[selectedIndex]) {
          selectedCard?.classList.remove('is-cut-marker', 'red-back');
          selectedCard?.classList.add('blue-back');
          selectedCard = cards[selectedIndex];
          selectedCard.classList.add('is-cut-marker', 'red-back');
        }
        if (hint) hint.textContent = `${this.game.pendingShoeCards?.totalCards ?? cards.length} cartas — cortando al ${(this.pendingCutPct * 100).toFixed(0)}%`;
      };

      deck.addEventListener('pointerdown', (e) => {
        dragging = true;
        deck.setPointerCapture(e.pointerId);
        updateFromPointer(e);
      });
      deck.addEventListener('pointermove', (e) => {
        if (dragging) updateFromPointer(e);
      });
      deck.addEventListener('pointerup', (e) => {
        dragging = false;
        if (deck.hasPointerCapture(e.pointerId)) deck.releasePointerCapture(e.pointerId);
      });
      deck.addEventListener('pointercancel', () => { dragging = false; });
    }
    const confirmBtn = this.root.querySelector('[data-confirm-cut]');
    if (confirmBtn) confirmBtn.addEventListener('click', () => this.confirmCut(this.pendingCutPct));
    const continueBtn = this.root.querySelector('[data-continue-after-cut]');
    if (continueBtn) continueBtn.addEventListener('click', () => this.continueAfterCut());
  }

  /**
   * Layout de 6 puestos alrededor de la mesa, como en una mesa real:
   * 1 y 6 arriba, 2 y 5 al medio, 3 y 4 abajo. Cada puesto muestra sus
   * cartas si está ocupado (jugador o bot), o queda vacío con solo el
   * número si nadie se sentó ahí.
   */
  renderSixSeatGrid(activeTarget, results, results2, insuranceProfit) {
    // En una mesa vista desde el jugador, el puesto 1 comienza a la derecha.
    const rows = [[6, 1], [5, 2], [4, 3]];
    const rowsHtml = rows.map(([left, right]) => `
      <div class="table-seats-row">
        ${this.renderOneTableSeat(left, activeTarget, results, results2, insuranceProfit)}
        ${this.renderOneTableSeat(right, activeTarget, results, results2, insuranceProfit)}
      </div>
    `).join('');
    return `<div class="table-seats-diamond">${rowsHtml}</div>`;
  }

  renderOneTableSeat(position, activeTarget, results, results2, insuranceProfit) {
    const entry = this.tableOrder.find(e => e.position === position);
    if (!entry || !entry.hand) {
      return `
        <div class="table-seat-slot empty" data-position="${position}">
          <span class="table-seat-num">${position}</span>
        </div>
      `;
    }

    const isPlayer = entry.type === 'player';
    const hand = entry.hand;
    const currentEntry = this.tableOrder[this.tableOrderIndex];
    const isCurrentPlayer = currentEntry === entry && !allPlayerHandsResolved(hand);
    const seatResults = isPlayer ? (entry.slot === 'hand' ? results : results2) : null;
    const label = isPlayer ? 'TÚ' : `🤖 ${entry.botName}`;

    const handsHtml = hand.playerHands.map((h, i) => {
      const r = seatResults ? seatResults[i] : null;
      let cls = '';
      if (r) {
        cls = r.result;
      } else if (isPlayer && activeTarget === entry.slot && i === hand.activeHandIndex) {
        cls = 'active';
      } else if (!isPlayer) {
        const status = h.status;
        if (status === 'bust') cls = 'loss';
        else if (status === 'win' || status === 'blackjack_win') cls = 'win';
        else if (status === 'loss' || status === 'dealer_blackjack') cls = 'loss';
        else if (status === 'push') cls = 'push';
      }
      return `
        <div class="hand-slot ${cls}" data-player-slot="${isPlayer ? entry.slot : ''}" data-hand-index="${i}">
          ${hand.playerHands.length > 1 ? `<div class="hand-slot-label">Jugada ${i + 1}</div>` : ''}
          <div class="seat-row">
            <div class="card-row">${this.renderCards(h.cards)}</div>
            <div class="total-pill">${handValue(h.cards).total}</div>
          </div>
          ${r ? `<div class="result-overlay">
            <span class="result-word ${r.result}">${RESULT_LABELS[r.result] || r.result.toUpperCase()}</span>
            <span class="result-amount">${r.profit > 0 ? '+' : ''}$${r.profit.toFixed(2)}</span>
            ${isPlayer && insuranceProfit !== 0 ? `
              <span class="result-insurance">Seguro: ${insuranceProfit > 0 ? '+' : ''}$${insuranceProfit.toFixed(2)}</span>
              <span class="result-net">Neto: ${(r.profit + insuranceProfit) > 0 ? '+' : ''}$${(r.profit + insuranceProfit).toFixed(2)}</span>
            ` : ''}
          </div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="table-seat-slot ${isCurrentPlayer ? 'current-player' : ''}" data-position="${position}">
        <div class="table-seat-label"><span class="table-seat-num">${position}</span> ${label}</div>
        <div class="hands-row">${handsHtml}</div>
      </div>
    `;
  }

  renderCards(cards) {
    // La primera carta repartida (índice 0) queda a la derecha, abajo del
    // todo; cada carta siguiente se monta encima y hacia la izquierda —
    // reproduciendo el orden real de reparto. z-index explícito garantiza
    // el apilamiento correcto sin depender del orden del DOM.
    const cutCard = this.game.shoe?.dealtSequence?.[this.game.shoe?.cutCardPosition];
    return cards.map((c, i) => `
      <div class="card ${['♥','♦'].includes(c.suit) ? 'red' : ''}" data-card-index="${i}" data-card-back="${c?.id === cutCard?.id ? 'red' : 'blue'}" style="z-index:${i};">
        <span class="idx idx-tl">${c.rank}<br>${c.suit}</span>
        <span class="card-center">${c.suit}</span>
        <span class="idx idx-br">${c.rank}<br>${c.suit}</span>
      </div>
    `).join('');
  }

  renderBottomHandTotals(activeTarget) {
    const ownSeats = this.tableMode === 'multi' && this.tableOrder.length
      ? this.tableOrder.filter(entry => entry.type === 'player' && entry.hand)
      : [
          this.hand ? { slot: 'hand', hand: this.hand } : null,
          this.hand2 ? { slot: 'hand2', hand: this.hand2 } : null,
        ].filter(Boolean);
    const totals = ownSeats.flatMap((entry, seatIndex) => entry.hand.playerHands.map((hand, handIndex) => ({
      label: ownSeats.length > 1
        ? `Posición ${seatIndex + 1}${entry.hand.playerHands.length > 1 ? ` · ${handIndex + 1}` : ''}`
        : (entry.hand.playerHands.length > 1 ? `Jugada ${handIndex + 1}` : 'Tu total'),
      total: handValue(hand.cards).total,
      active: activeTarget === entry.slot && entry.hand.activeHandIndex === handIndex,
    })));
    if (!totals.length) return '';
    return `<div class="bottom-hand-totals" aria-label="Totales de tus manos">
      ${totals.map(item => `<div class="bottom-hand-total ${item.active ? 'active' : ''}"><small>${item.label}</small><strong>${item.total}</strong></div>`).join('')}
    </div>`;
  }

  /** Saca visualmente el zapato completo y lo abre sobre el fieltro. */
  async animateShoeToCutStage() {
    const spread = this.root.querySelector('[data-cut-spread]');
    const shoeCard = this.root.querySelector('[data-shoe-pile] .pile-card-back:last-child');
    const confirmBtn = this.root.querySelector('[data-confirm-cut]');
    if (!spread) return;

    const spreadRect = spread.getBoundingClientRect();
    const shoeRect = shoeCard?.getBoundingClientRect();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    spread.style.clipPath = '';
    spread.style.visibility = reducedMotion ? 'visible' : 'hidden';
    this.root.classList.add('cut-shoe-empty');

    // Un proxy redondeado representa el paquete durante la llegada y la
    // apertura. Solo anima UN elemento; las 312 cartas reales permanecen
    // ocultas y ya colocadas hasta el relevo final.
    if (!reducedMotion && shoeRect?.width && spreadRect.width) {
      spread.dataset.cutPhase = 'opening-shoe';
      const animationHost = this.root.closest('.app-viewport') || document.body;
      const hostRect = animationHost === document.body
        ? { left: 0, top: 0, width: document.documentElement.clientWidth }
        : animationHost.getBoundingClientRect();
      const hostScale = animationHost === document.body
        ? 1
        : (hostRect.width / animationHost.offsetWidth || 1);
      const localRect = rect => ({
        left: (rect.left - hostRect.left) / hostScale,
        top: (rect.top - hostRect.top) / hostScale,
        width: rect.width / hostScale,
        height: rect.height / hostScale,
      });
      const localSpread = localRect(spreadRect);
      const localShoe = localRect(shoeRect);
      const proxy = document.createElement('div');
      proxy.className = 'cut-deck-opening-proxy';
      const targetTop = localSpread.top + 7;
      const targetCenterLeft = localSpread.left + localSpread.width / 2 - 21;
      Object.assign(proxy.style, {
        position: animationHost === document.body ? 'fixed' : 'absolute',
        left: `${localShoe.left + localShoe.width / 2 - 21}px`,
        top: `${localShoe.top + localShoe.height / 2 - 31}px`,
        width: '42px',
      });
      animationHost.appendChild(proxy);
      const dx = targetCenterLeft - Number.parseFloat(proxy.style.left);
      const dy = targetTop - Number.parseFloat(proxy.style.top);
      const flight = proxy.animate([
        { transform: 'translate3d(0,0,0) scale(.55) rotate(7deg)', opacity: .76 },
        { transform: `translate3d(${dx}px,${dy}px,0) scale(1) rotate(0deg)`, opacity: 1 },
      ], { duration: 420, easing: 'cubic-bezier(.2,.78,.24,1)', fill: 'forwards' });
      await flight.finished.catch(() => {});
      flight.cancel();
      proxy.style.left = `${targetCenterLeft}px`;
      proxy.style.top = `${targetTop}px`;
      proxy.style.transform = 'none';

      const open = proxy.animate([
        { left: `${targetCenterLeft}px`, width: '42px' },
        { left: `${localSpread.left}px`, width: `${localSpread.width}px` },
      ], { duration: 340, easing: 'cubic-bezier(.2,.75,.24,1)', fill: 'forwards' });
      await open.finished.catch(() => {});
      spread.style.visibility = 'visible';
      proxy.remove();
    }
    spread.style.visibility = 'visible';
    spread.classList.add('is-spread');
    spread.classList.add('is-interactive');
    const initialIndex = Number(spread.dataset.initialCutIndex);
    const initialMarker = spread.querySelector(`[data-cut-card-index="${initialIndex}"]`);
    initialMarker?.classList.add('is-cut-marker', 'red-back');
    spread.closest('[data-cut-deck]')?.classList.remove('is-locked');
    spread.dataset.cutPhase = 'ready';
    if (confirmBtn) confirmBtn.disabled = false;
  }

  /**
   * Representa el corte físico sin volver a calcular ninguna regla:
   * envuelve el bloque superior, inserta la roja a la profundidad que ya
   * decidió el motor y devuelve el zapato armado a su esquina.
   */
  async animateCutSequence(cutPct, cutCardPosition) {
    const stage = this.root.querySelector('[data-cut-deck]');
    const spread = this.root.querySelector('[data-cut-spread]');
    const shoe = this.root.querySelector('[data-shoe-pile]');
    if (!stage || !spread || !shoe) return;

    const cards = [...spread.querySelectorAll('[data-cut-card-index]')];
    if (!cards.length) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const selectedIndex = Math.min(cards.length - 1, Math.max(0, Math.round(cutPct * (cards.length - 1))));
    const redCard = cards[selectedIndex];
    const confirmBtn = this.root.querySelector('[data-confirm-cut]');
    if (confirmBtn) confirmBtn.disabled = true;
    stage.classList.add('is-locked');
    stage.setAttribute('aria-busy', 'true');
    spread.classList.remove('is-interactive');
    spread.classList.add('is-confirmed');
    this.root.classList.add('cut-sequence-running');

    // Al confirmar, la roja deja de sobresalir: se alinea con todas las
    // cartas y permanece visible/encima durante el corte completo.
    redCard.classList.add('is-cut-marker', 'red-back');
    redCard.style.transform = 'translate3d(0,0,0)';
    redCard.style.translate = '0 0';
    redCard.style.opacity = '1';
    redCard.style.zIndex = String(cards.length + 20);

    if (!reducedMotion && typeof redCard.animate === 'function') {
      // Un solo movimiento combinado: el frente original arquea hacia el
      // fondo mientras el bloque posterior pasa al frente por debajo.
      const redBlock = cards.slice(0, selectedIndex + 1);
      const upperBlock = cards.slice(selectedIndex + 1);
      upperBlock.forEach((card, index) => { card.style.zIndex = String(index + 1); });
      redBlock.forEach((card, index) => { card.style.zIndex = String(upperBlock.length + index + 2); });
      redCard.style.zIndex = String(cards.length + 20);
      const spacing = cards.length > 1 ? 278 / (cards.length - 1) : 0;
      const straightLineState = cards.map((card, originalIndex) => {
        const newIndex = originalIndex > selectedIndex
          ? originalIndex - selectedIndex - 1
          : upperBlock.length + originalIndex;
        const originalX = Number.parseFloat(card.style.getPropertyValue('--cut-x')) || 0;
        const targetX = newIndex * spacing;
        return { card, originalIndex, newIndex, dx: targetX - originalX };
      });
      spread.dataset.cutPhase = 'swapping';
      const swapAnimations = straightLineState.map(({ card, originalIndex, dx }) => {
        const movesToBack = originalIndex <= selectedIndex;
        return card.animate([
          { transform: 'translate3d(0,0,0)' },
          { transform: `translate3d(${dx * .52}px,${movesToBack ? -34 : 34}px,0) rotate(${movesToBack ? 1 : -1}deg)`, offset: .5 },
          { transform: `translate3d(${dx}px,0,0) rotate(0deg)` },
        ], {
          duration: 640,
          easing: 'cubic-bezier(.3,.02,.18,1)',
          fill: 'forwards',
        });
      });
      await Promise.all(swapAnimations.map(animation => animation.finished.catch(() => {})));
      swapAnimations.forEach(animation => {
        animation.commitStyles?.();
        animation.cancel();
      });
      straightLineState.forEach(({ card, newIndex, dx }) => {
        card.style.transform = `translate3d(${dx}px,0,0)`;
        card.style.zIndex = String(newIndex + 1);
      });
      spread.classList.add('is-straight-line');
      spread.dataset.cutPhase = 'straight';

      redCard.style.zIndex = String(cards.length + 20);
      redCard.style.translate = '0 0';
      redCard.style.opacity = '1';
      await sleep(360);

      // Primero toda la línea se comprime. La roja sigue arriba y alineada
      // hasta que ya existe un único paquete del tamaño de una carta.
      spread.dataset.cutPhase = 'collapsing';
      const collapseAnimations = cards.map(card => {
        const currentTransform = getComputedStyle(card).transform;
        const x = Number.parseFloat(card.style.getPropertyValue('--cut-x')) || 0;
        return card.animate([
          { transform: currentTransform === 'none' ? 'translate3d(0,0,0)' : currentTransform },
          { transform: `translate3d(${139 - x}px,0,0) rotate(0deg)` },
        ], {
          duration: 360,
          easing: 'cubic-bezier(.24,.7,.2,1)',
          fill: 'forwards',
        });
      });
      await Promise.all(collapseAnimations.map(animation => animation.finished.catch(() => {})));
      spread.classList.remove('is-straight-line');
      spread.dataset.cutPhase = 'collapsed';
      await sleep(110);

      // Ya colapsado: la roja sale a la derecha, cambia a su profundidad
      // real y vuelve a entrar recta por debajo de las cartas azules.
      const redDepth = Math.max(2, Math.min(cards.length - 2, cards.length - cutCardPosition));
      spread.dataset.cutPhase = 'red-sliding-out';
      const redSlideOut = redCard.animate([
        { translate: '0 0' },
        { translate: '38px 0' },
      ], { duration: 185, easing: 'cubic-bezier(.3,.02,.2,1)', fill: 'forwards' });
      await redSlideOut.finished.catch(() => {});
      redSlideOut.commitStyles?.();
      redSlideOut.cancel();
      redCard.style.translate = '38px 0';
      redCard.style.zIndex = String(redDepth);
      spread.dataset.cutPhase = 'red-sliding-under';
      const redSlideUnder = redCard.animate([
        { translate: '38px 0' },
        { translate: '0 0' },
      ], { duration: 215, easing: 'cubic-bezier(.2,.72,.2,1)', fill: 'forwards' });
      await redSlideUnder.finished.catch(() => {});
      redSlideUnder.commitStyles?.();
      redSlideUnder.cancel();
      redCard.style.translate = '0 0';
      spread.dataset.cutPhase = 'red-inserted';
      await sleep(120);

      // El paquete completo vuelve a la ubicación del zapato; el zapato
      // de tres cartas reaparece solo cuando el paquete está aterrizando.
      const spreadRect = spread.getBoundingClientRect();
      const shoeRect = shoe.getBoundingClientRect();
      const dx = (shoeRect.left + shoeRect.width / 2) - (spreadRect.left + spreadRect.width / 2);
      const dy = (shoeRect.top + shoeRect.height / 2) - (spreadRect.top + spreadRect.height / 2);
      const scale = Math.max(.12, Math.min(shoeRect.width / spreadRect.width, .24));
      const returnFlight = spread.animate([
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
        { transform: `translate3d(${dx}px,${dy}px,0) scale(${scale}) rotate(7deg)`, opacity: .8 },
      ], { duration: 540, easing: 'cubic-bezier(.24,.68,.2,1)', fill: 'forwards' });
      await sleep(390);
      this.root.classList.remove('cut-shoe-empty');
      await returnFlight.finished.catch(() => {});
    } else {
      this.root.classList.remove('cut-shoe-empty');
    }

    stage.removeAttribute('aria-busy');
  }

  async animateInitialDeal() {
    const shoe = this.root.querySelector('[data-shoe-pile] .pile-card-back:last-child');
    if (!shoe) return;
    const cards = [...this.root.querySelectorAll('.card')];
    const seatRank = card => {
      if (card.closest('[data-dealer-cards]')) return 99;
      const position = Number(card.closest('[data-position]')?.dataset.position);
      if (position) return position;
      return card.closest('[data-player-slot="hand2"]') ? 2 : 1;
    };
    cards.sort((a, b) => Number(a.dataset.cardIndex) - Number(b.dataset.cardIndex) || seatRank(a) - seatRank(b));
    cards.forEach(card => { card.style.opacity = '0'; });
    const flights = [];
    for (const card of cards) {
      flights.push(this.flyCard(shoe, card, { revealTarget: true }));
      await sleep(75);
    }
    await Promise.all(flights);
  }

  async animateCardFromShoe(selector) {
    const shoe = this.root.querySelector('[data-shoe-pile] .pile-card-back:last-child');
    const target = this.root.querySelector(selector);
    if (!shoe || !target) return;
    target.style.opacity = '0';
    await this.flyCard(shoe, target, { revealTarget: true });
  }

  async flyCard(source, target, { revealTarget = false, face = false, delay = 0 } = {}) {
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!sourceRect.width || !targetRect.width) {
      if (revealTarget) target.style.opacity = '';
      return;
    }
    const animationHost = this.root.closest('.app-viewport') || document.body;
    const hostRect = animationHost === document.body
      ? { left: 0, top: 0, width: document.documentElement.clientWidth }
      : animationHost.getBoundingClientRect();
    const hostScale = animationHost === document.body
      ? 1
      : (hostRect.width / animationHost.offsetWidth || 1);
    const localRect = rect => ({
      left: (rect.left - hostRect.left) / hostScale,
      top: (rect.top - hostRect.top) / hostScale,
      width: rect.width / hostScale,
      height: rect.height / hostScale,
    });
    const localSource = localRect(sourceRect);
    const localTarget = localRect(targetRect);
    const flying = face ? source.cloneNode(true) : document.createElement('div');
    flying.className = face
      ? `${source.className} flying-table-card`
      : `card face-down ${target.dataset.cardBack === 'red' ? 'red-back' : 'blue-back'} flying-table-card`;
    const flightWidth = face ? localSource.width : localTarget.width;
    const flightHeight = face ? localSource.height : localTarget.height;
    const startLeft = localSource.left + localSource.width / 2 - flightWidth / 2;
    const startTop = localSource.top + localSource.height / 2 - flightHeight / 2;
    const finishLeft = localTarget.left + localTarget.width / 2 - flightWidth / 2;
    const finishTop = localTarget.top + localTarget.height / 2 - flightHeight / 2;
    const pileToCardScale = Math.min(localSource.width / localTarget.width, localSource.height / localTarget.height);
    const cardToPileScale = Math.min(localTarget.width / localSource.width, localTarget.height / localSource.height);
    const startScale = face ? 1 : pileToCardScale;
    const endScale = face ? cardToPileScale : 1;
    const middleScale = startScale + ((endScale - startScale) * .58) + .025;
    Object.assign(flying.style, {
      position: animationHost === document.body ? 'fixed' : 'absolute', left: `${startLeft}px`, top: `${startTop}px`, width: `${flightWidth}px`,
      height: `${flightHeight}px`, margin: '0', zIndex: '1200', pointerEvents: 'none', opacity: '1',
    });
    animationHost.appendChild(flying);
    const dx = finishLeft - startLeft;
    const dy = finishTop - startTop;
    if (typeof flying.animate !== 'function') {
      flying.remove();
      if (revealTarget) target.style.opacity = '';
      return;
    }
    const animation = flying.animate([
      { transform: `translate3d(0,0,0) rotate(-5deg) scale(${startScale})` },
      { transform: `translate3d(${dx * .55}px,${dy * .48 - 18}px,0) rotate(4deg) scale(${middleScale})`, offset: .58 },
      { transform: `translate3d(${dx}px,${dy}px,0) rotate(0deg) scale(${endScale})` },
    ], { duration: 330, delay, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'forwards' });
    await animation.finished.catch(() => {});
    flying.remove();
    if (revealTarget) target.style.opacity = '';
  }

  async animateDealerReveal() {
    const dealerCards = [...this.root.querySelectorAll('[data-dealer-cards] .card')];
    const holeCard = dealerCards.find(card => card.dataset.cardIndex === '1');
    if (holeCard) {
      holeCard.classList.add('dealer-flip-reveal');
      await sleep(360);
    }
    for (const card of dealerCards.filter(card => Number(card.dataset.cardIndex) > 1)) {
      await this.animateCardFromShoe(`[data-dealer-cards] .card[data-card-index="${card.dataset.cardIndex}"]`);
      await sleep(90);
    }
  }

  async animateCardsToDiscard() {
    const discard = this.root.querySelector('[data-discard-pile]');
    const cards = [...this.root.querySelectorAll('.card')].filter(card => !card.closest('.table-card-pile'));
    if (!discard || !cards.length) return;
    this.cardsInMotion = true;
    this.root.classList.add('cards-in-motion');
    const flights = [];
    cards.reverse().forEach((card, index) => {
      card.classList.remove('dealer-flip-reveal');
      card.style.opacity = '0';
      flights.push((async () => {
        await sleep(index * 42);
        await this.flyCard(card, discard.querySelector('.pile-drop-target'), { face: true });
        this.discardBacks.push(card.dataset.cardBack === 'red' ? 'red' : 'blue');
        this.updateDiscardPileVisual();
      })());
    });
    await Promise.all(flights);
    this.cardsInMotion = false;
    this.root.classList.remove('cards-in-motion');
  }

  updateDiscardPileVisual() {
    const pile = this.root.querySelector('[data-discard-pile]');
    const stack = pile?.querySelector('[data-discard-stack]');
    if (!pile || !stack) return;
    const visible = this.discardBacks.slice(-3);
    stack.innerHTML = visible.map((back, index) => `<span class="pile-card-back ${back}-back" style="--pile-depth:${visible.length - index - 1}"></span>`).join('');
    pile.setAttribute('aria-label', `Pila de descarte: ${this.discardBacks.length} ${this.discardBacks.length === 1 ? 'carta' : 'cartas'}`);
    const label = pile.querySelector('small');
    if (label) label.textContent = 'DESCARTE';
  }

  renderRecentHistory() {
    if (this.recentHistory.length === 0) {
      return '<div class="history-empty">Termina una mano para comenzar tu historial.</div>';
    }

    const typeLabels = {
      hard: ['Dura', 'Mano dura: no tiene un As flexible que pueda valer 11'],
      soft: ['Suave', 'Mano suave: tiene un As que puede valer 11 sin pasarse'],
      pair: ['Pareja', 'Pareja: las dos cartas iniciales tienen el mismo valor'],
      blackjack: ['Blackjack', 'Blackjack natural con las dos cartas iniciales'],
    };
    const actionLabels = { hit: 'Pedir', stand: 'Plantarse', double: 'Doblar', split: 'Dividir', insurance: 'Seguro' };
    const resultLabels = {
      win: ['Ganó', 'Ganó', 'history-win'],
      blackjack: ['BJ', 'Blackjack', 'history-win'],
      loss: ['Perdió', 'Perdió', 'history-loss'],
      push: ['Empate', 'Empate', 'history-push'],
    };

    return this.recentHistory.map(item => {
      const type = typeLabels[item.handType] ?? [item.handType, item.handType];
      const result = resultLabels[item.result] ?? ['—', item.result, 'history-push'];
      const action = actionLabels[item.action] ?? 'Sin decisión';
      return `
        <div class="history-row">
          <em title="${this.escapeHtml(type[1])}">${this.escapeHtml(type[0])}</em>
          <span>${item.playerTotal} vs ${this.escapeHtml(item.dealerUpcard)}</span>
          <b>${this.escapeHtml(action)}</b>
          <i class="${result[2]}" title="${this.escapeHtml(result[1])}">${result[0]}</i>
          <strong class="${item.profit < 0 ? 'negative' : ''}">${item.profit > 0 ? '+' : ''}$${item.profit.toFixed(2)}</strong>
        </div>
      `;
    }).join('');
  }

  renderFaceDownCard(card = null) {
    const cutCard = this.game.shoe?.dealtSequence?.[this.game.shoe?.cutCardPosition];
    const back = card?.id === cutCard?.id ? 'red' : 'blue';
    return `<div class="card face-down ${back}-back" data-card-back="${back}" data-card-index="1" style="z-index:-1;" aria-label="Carta tapada"></div>`;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
