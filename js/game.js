// game.js — Motor de una mano de blackjack clásico (6 barajas, dealer
// se planta en 17, DAS permitido, split hasta 4 manos, insurance).
// No sabe nada de Supabase ni del DOM — solo reglas del juego.
// game-repository.js persiste lo que este módulo produce.
// game-ui.js llama a estas funciones desde los botones.

import { createShoe, shuffleForNewShoe, finalizeShoeCut, dealCard, isPastCutCard, handValue, RANK_VALUE } from './deck.js';
import { basicStrategyAction, normalizeDealerUpcard, ACTIONS } from './strategy.js';
import { buildDecisionAnalytics } from './analytics.js';
import { computeExactEV } from './ev-engine.js';

export function createGame({ numDecks = 6, rng = Math.random } = {}) {
  return {
    numDecks,
    rng,
    shoe: null,
    shoeNumber: 0,
    handNumberInShoe: 0,
    handsPlayedInSession: 0,
    currentStreak: 0, // positivo = racha ganadora, negativo = racha perdedora
  };
}

export function startNewShoe(game) {
  game.shoe = createShoe({ numDecks: game.numDecks, rng: game.rng });
  game.shoeNumber += 1;
  game.handNumberInShoe = 0;
  return game.shoe;
}

/**
 * PASO 1 del ritual de corte interactivo: baraja un zapato nuevo y lo
 * deja "pendiente" (game.pendingShoeCards) sin cortar todavía —
 * game.shoe NO se toca aún, así que el zapato anterior sigue disponible
 * para guardarse en Supabase antes de reemplazarlo.
 */
export function beginShoeShuffle(game) {
  game.pendingShoeCards = shuffleForNewShoe({ numDecks: game.numDecks, rng: game.rng });
  return game.pendingShoeCards;
}

/**
 * PASO 2 del ritual de corte interactivo: el jugador ya eligió dónde
 * cortar (cutPosition, un índice de carta dentro del zapato barajado
 * pendiente). Aplica el corte, quema la primera carta, y esta vez SÍ
 * reemplaza game.shoe. Devuelve la carta quemada para mostrarla.
 */
export function confirmShoeCut(game, cutPosition) {
  if (!game.pendingShoeCards) throw new Error('No hay un zapato barajado pendiente de cortar.');
  const { shoe, burnedCard } = finalizeShoeCut(game.pendingShoeCards, cutPosition, game.rng);
  game.shoe = shoe;
  game.shoeNumber += 1;
  game.handNumberInShoe = 0;
  game.pendingShoeCards = null;
  return burnedCard;
}

export function shoeNeedsReplacement(game) {
  return !game.shoe || isPastCutCard(game.shoe);
}

/**
 * Reparte la ronda inicial: Jugador 1, Casa 1 (abierta), Jugador 2,
 * Casa 2 (tapada) — orden estricto, tal como documentado en v6.0.
 * Devuelve el estado de la mano lista para que el jugador decida.
 */
export function dealInitialRound(game, { betAmount, bankrollBeforeHand, previousBetAmount }) {
  if (shoeNeedsReplacement(game)) startNewShoe(game);
  game.handNumberInShoe += 1;
  game.handsPlayedInSession += 1;

  const shoe = game.shoe;
  const playerCards = [dealCard(shoe)];
  const dealerCards = [dealCard(shoe)]; // dealer[0] visible
  playerCards.push(dealCard(shoe));
  dealerCards.push(dealCard(shoe)); // dealer[1] tapada (hole card)

  const dealerUpcard = normalizeDealerUpcard(dealerCards[0].rank);
  const playerBJ = handValue(playerCards).isBlackjack;
  const dealerShowsAce = dealerCards[0].rank === 'A';
  const dealerShowsTen = ['10','J','Q','K'].includes(dealerCards[0].rank);

  const hand = {
    handNumberInShoe: game.handNumberInShoe,
    shoeNumber: game.shoeNumber,
    betAmount,
    bankrollBeforeHand,
    previousBetAmount: previousBetAmount ?? null,
    currentStreakBeforeHand: game.currentStreak,
    handsPlayedInSessionSoFar: game.handsPlayedInSession - 1,
    dealerUpcard,
    dealerHoleCard: dealerCards[1],
    dealerCards,
    playerHands: [
      { cards: playerCards, bet: betAmount, status: 'active', isDoubled: false, isSplitAces: false, splitIndex: 0 },
    ],
    activeHandIndex: 0,
    insurance: dealerShowsAce ? { offered: true, taken: null, amount: 0 } : { offered: false },
    decisions: [], // se va llenando con cada acción tomada
    startedAt: new Date().toISOString(),
    naturalBlackjackResolved: false,
  };

  // Blackjack natural del jugador: la casa no toma cartas adicionales
  // salvo para revisar si también tiene blackjack (push) cuando
  // corresponde revisar (10 o A visibles).
  if (playerBJ && (dealerShowsAce || dealerShowsTen)) {
    const dealerBJ = handValue(dealerCards).isBlackjack;
    hand.naturalBlackjackResolved = true;
    hand.playerHands[0].status = dealerBJ ? 'push' : 'blackjack_win';
  } else if (playerBJ) {
    hand.naturalBlackjackResolved = true;
    hand.playerHands[0].status = 'blackjack_win';
  } else if (dealerShowsTen) {
    // Si casa muestra 10, revisa la tapada: si es As, blackjack natural
    // de la casa y gana automáticamente sin consumir cartas extra.
    const dealerBJ = handValue(dealerCards).isBlackjack;
    if (dealerBJ) {
      hand.naturalBlackjackResolved = true;
      hand.playerHands[0].status = 'dealer_blackjack';
    }
  }

  return hand;
}

/**
 * Reparte una ronda para varios puestos que comparten el MISMO zapato y
 * la MISMA mano de casa — a diferencia de llamar dealInitialRound()
 * varias veces (que crearía una casa distinta por cada llamada, algo
 * incorrecto). Orden real de reparto: una carta a cada puesto en orden,
 * luego la casa (visible), otra vuelta a cada puesto, luego la casa
 * (tapada).
 *
 * seatConfigs: array de { betAmount, bankrollBeforeHand, previousBetAmount }
 * Devuelve: array de objetos "hand" — cada uno con la MISMA forma que
 * devuelve dealInitialRound(), así que availableActions/applyPlayerAction/
 * resolveHandResults/resolveInsurance se reutilizan sin cambios, por
 * puesto. Los objetos comparten la misma referencia a dealerCards.
 */
export function dealMultiSeatRound(game, seatConfigs) {
  if (shoeNeedsReplacement(game)) startNewShoe(game);
  game.handNumberInShoe += 1;
  game.handsPlayedInSession += 1;

  const shoe = game.shoe;
  const numSeats = seatConfigs.length;
  const seatCardsRound1 = Array.from({ length: numSeats }, () => dealCard(shoe));
  const dealerCards = [dealCard(shoe)]; // dealer[0] visible
  const seatCardsRound2 = Array.from({ length: numSeats }, () => dealCard(shoe));
  dealerCards.push(dealCard(shoe)); // dealer[1] tapada

  const dealerUpcard = normalizeDealerUpcard(dealerCards[0].rank);
  const dealerShowsAce = dealerCards[0].rank === 'A';
  const dealerShowsTen = ['10', 'J', 'Q', 'K'].includes(dealerCards[0].rank);

  return seatConfigs.map((cfg, i) => {
    const playerCards = [seatCardsRound1[i], seatCardsRound2[i]];
    const playerBJ = handValue(playerCards).isBlackjack;

    const hand = {
      handNumberInShoe: game.handNumberInShoe,
      shoeNumber: game.shoeNumber,
      seatNumber: i + 1,
      betAmount: cfg.betAmount,
      bankrollBeforeHand: cfg.bankrollBeforeHand,
      previousBetAmount: cfg.previousBetAmount ?? null,
      currentStreakBeforeHand: game.currentStreak,
      handsPlayedInSessionSoFar: game.handsPlayedInSession - 1,
      dealerUpcard,
      dealerHoleCard: dealerCards[1],
      dealerCards, // referencia COMPARTIDA entre todos los puestos de esta ronda
      playerHands: [
        { cards: playerCards, bet: cfg.betAmount, status: 'active', isDoubled: false, isSplitAces: false, splitIndex: 0 },
      ],
      activeHandIndex: 0,
      insurance: dealerShowsAce ? { offered: true, taken: null, amount: 0 } : { offered: false },
      decisions: [],
      startedAt: new Date().toISOString(),
      naturalBlackjackResolved: false,
    };

    if (playerBJ && (dealerShowsAce || dealerShowsTen)) {
      const dealerBJ = handValue(dealerCards).isBlackjack;
      hand.naturalBlackjackResolved = true;
      hand.playerHands[0].status = dealerBJ ? 'push' : 'blackjack_win';
    } else if (playerBJ) {
      hand.naturalBlackjackResolved = true;
      hand.playerHands[0].status = 'blackjack_win';
    } else if (dealerShowsTen) {
      const dealerBJ = handValue(dealerCards).isBlackjack;
      if (dealerBJ) {
        hand.naturalBlackjackResolved = true;
        hand.playerHands[0].status = 'dealer_blackjack';
      }
    }

    return hand;
  });
}

/**
 * Juega la mano de la casa UNA sola vez para toda la mesa (no por
 * puesto — comparten la misma casa). Solo se detiene sin repartir si
 * TODOS los puestos ya están resueltos o todos reventados — si al
 * menos uno sigue con posibilidad de ganar, la casa juega normal.
 */
export function playDealerHandMultiSeat(game, seats) {
  const dealerStillMatters = seats.some(s => !s.naturalBlackjackResolved && !allPlayerHandsBusted(s));
  if (!dealerStillMatters) return seats[0].dealerCards;

  let v = handValue(seats[0].dealerCards);
  while (v.total < 17) {
    seats[0].dealerCards.push(dealCard(game.shoe));
    v = handValue(seats[0].dealerCards);
  }
  return seats[0].dealerCards;
}

/** Determina las acciones disponibles para la mano activa en este momento. */
export function availableActions(hand, bankroll) {
  if (hand.naturalBlackjackResolved) return [];
  const active = hand.playerHands[hand.activeHandIndex];
  if (!active || active.status !== 'active') return [];

  const actions = [ACTIONS.HIT, ACTIONS.STAND];
  const { total } = handValue(active.cards);
  const canAffordDouble = bankroll >= active.bet;
  const canAffordSplit = bankroll >= active.bet;

  if (
    active.cards.length === 2 &&
    canAffordDouble &&
    !active.isSplitAces &&
    total >= 9 && total <= 11
  ) {
    actions.push(ACTIONS.DOUBLE);
  }
  if (
    active.cards.length === 2 &&
    active.cards[0].rank === active.cards[1].rank &&
    hand.playerHands.length < 4 &&
    canAffordSplit
  ) {
    actions.push(ACTIONS.SPLIT);
  }
  return actions;
}

/**
 * Registra y aplica una decisión del jugador sobre la mano activa.
 * Este es el punto central donde se calcula, ANTES de aplicar la
 * acción, cuál era la jugada óptima (básica y exacta) — para poder
 * comparar contra lo que el jugador realmente hizo.
 */
export function applyPlayerAction(game, hand, playerAction) {
  const active = hand.playerHands[hand.activeHandIndex];
  const { total, isSoft } = handValue(active.cards);
  const isPair = active.cards.length === 2 && active.cards[0].rank === active.cards[1].rank;

  const handType = isPair ? 'pair' : (isSoft ? 'soft' : 'hard');
  const key = isPair
    ? (active.cards[0].rank === 'A' ? 'A' : normalizeDealerUpcard(active.cards[0].rank))
    : isSoft
      ? total - 11 // A-2 → 2, A-9 → 9 (el valor que acompaña al As, no el total completo)
      : total;

  // Analítica ANTES de repartir la carta de esta decisión
  const analytics = buildDecisionAnalytics(game.shoe, game.numDecks, hand.dealerHoleCard ? [hand.dealerHoleCard] : []);

  const expected = basicStrategyAction(handType, key, hand.dealerUpcard);

  const isCorrect = playerAction === expected;

  // Cálculo real de EV (motor combinatorio/probabilístico, ver ev-engine.js)
  const legalActionsForEV = availableActions(hand, Infinity);
  const pairRank = isPair ? (active.cards[0].rank === 'A' ? 'A' : normalizeDealerUpcard(active.cards[0].rank)) : null;
  const evResult = computeExactEV({
    playerTotal: total,
    playerIsSoft: isSoft,
    isPair,
    pairRank,
    composition: analytics.remaining_composition,
    dealerUpcardRank: normalizeDealerUpcard(hand.dealerUpcard),
    legalActions: legalActionsForEV,
  });
  const evChosen = evResult.evByAction[playerAction] ?? evResult.bestEV;
  const evLoss = Math.max(0, (evResult.bestEV - evChosen) * active.bet);

  const decisionRecord = {
    playerHandIndex: hand.activeHandIndex,
    playerCards: active.cards.slice(),
    dealerUpcard: hand.dealerUpcard,
    playerTotal: total,
    handType,
    availableActions: legalActionsForEV,
    playerAction,
    expectedAction: expected,
    isCorrect,
    evLoss,
    remainingComposition: analytics.remaining_composition,
    evOptimalActionExact: evResult.bestEV,
    optimalActionExact: evResult.bestAction,
    deviatedFromBasicTable: evResult.bestAction !== expected,
    runningCount: analytics.running_count,
    trueCount: analytics.true_count,
  };
  hand.decisions.push(decisionRecord);

  // Aplica la acción real al estado del juego
  switch (playerAction) {
    case ACTIONS.HIT: {
      active.cards.push(dealCard(game.shoe));
      const v = handValue(active.cards);
      if (v.total > 21) active.status = 'bust';
      break;
    }
    case ACTIONS.STAND: {
      active.status = 'stood';
      break;
    }
    case ACTIONS.DOUBLE: {
      active.cards.push(dealCard(game.shoe));
      active.bet *= 2;
      active.isDoubled = true;
      const v = handValue(active.cards);
      active.status = v.total > 21 ? 'bust' : 'stood';
      break;
    }
    case ACTIONS.SPLIT: {
      const [cardA, cardB] = active.cards;
      const isAceSplit = cardA.rank === 'A';
      active.cards = [cardA, dealCard(game.shoe)];
      active.isSplitAces = isAceSplit;
      const newHand = {
        cards: [cardB, dealCard(game.shoe)],
        bet: active.bet,
        status: isAceSplit ? 'stood' : 'active', // Ases divididos: la segunda mano también recibe solo una carta, sin poder pedir más
        isDoubled: false,
        isSplitAces: isAceSplit,
        splitIndex: hand.playerHands.length,
      };
      hand.playerHands.splice(hand.activeHandIndex + 1, 0, newHand);
      // Ases divididos reciben exactamente una carta adicional por mano
      if (isAceSplit) {
        active.status = 'stood';
      } else {
        const v = handValue(active.cards);
        if (v.total > 21) active.status = 'bust';
      }
      break;
    }
    default:
      throw new Error(`Acción desconocida: ${playerAction}`);
  }

  advanceToNextActiveHand(hand);
  return decisionRecord;
}

/** Mueve activeHandIndex a la siguiente mano que siga 'active'; si no hay más, queda en null. */
function advanceToNextActiveHand(hand) {
  // Si la mano activa actual todavía sigue en juego (recién dividida, por
  // ejemplo), no hay que avanzar — sigue siendo su turno.
  const current = hand.playerHands[hand.activeHandIndex];
  if (current && current.status === 'active') return;

  for (let i = hand.activeHandIndex + 1; i < hand.playerHands.length; i++) {
    if (hand.playerHands[i].status === 'active') {
      hand.activeHandIndex = i;
      return;
    }
  }
  hand.activeHandIndex = -1; // todas resueltas o esperando al dealer
}

export function allPlayerHandsResolved(hand) {
  return hand.playerHands.every(h => h.status !== 'active');
}

export function allPlayerHandsBusted(hand) {
  return hand.playerHands.every(h => h.status === 'bust');
}

/**
 * Juega la mano de la casa: pide hasta 17 (incluyendo 17 blando —
 * dealer se planta en cualquier 17, regla "clásica" documentada).
 * No roba cartas si el jugador ya se pasó en todas sus manos.
 */
export function playDealerHand(game, hand) {
  if (hand.naturalBlackjackResolved) return hand.dealerCards;
  if (allPlayerHandsBusted(hand)) return hand.dealerCards; // no consume cartas innecesarias

  let v = handValue(hand.dealerCards);
  while (v.total < 17) {
    hand.dealerCards.push(dealCard(game.shoe));
    v = handValue(hand.dealerCards);
  }
  return hand.dealerCards;
}

/** Resuelve el insurance según la carta tapada del dealer. */
export function resolveInsurance(hand, took, insuranceAmount) {
  const dealerBJ = handValue(hand.dealerCards).isBlackjack;
  hand.insurance = { offered: true, taken: took, amount: took ? insuranceAmount : 0, won: took && dealerBJ };
  if (dealerBJ) {
    // La casa gana la mano principal en cualquier caso cuando tiene
    // blackjack — el seguro es una apuesta lateral, no reemplaza el
    // resultado de la mano. Antes solo se cerraba si el jugador NO
    // tomaba el seguro, dejando la mano "activa" (bug) cuando sí lo tomaba.
    hand.playerHands.forEach(h => { h.status = 'dealer_blackjack'; });
  }
  return hand.insurance;
}

/**
 * Calcula el resultado y profit de cada mano del jugador contra la
 * mano final de la casa. Devuelve un resumen por mano + el total.
 */
export function resolveHandResults(hand) {
  const dealerValue = handValue(hand.dealerCards);
  const dealerBust = dealerValue.total > 21;

  const results = hand.playerHands.map(ph => {
    if (ph.status === 'blackjack_win') return { ...ph, result: 'blackjack', profit: ph.bet * 1.5 };
    if (ph.status === 'push') return { ...ph, result: 'push', profit: 0 };
    if (ph.status === 'dealer_blackjack') return { ...ph, result: 'loss', profit: -ph.bet };
    if (ph.status === 'bust') return { ...ph, result: 'loss', profit: -ph.bet };

    const playerValue = handValue(ph.cards);
    if (dealerBust) return { ...ph, result: 'win', profit: ph.bet };
    if (playerValue.total > dealerValue.total) return { ...ph, result: 'win', profit: ph.bet };
    if (playerValue.total < dealerValue.total) return { ...ph, result: 'loss', profit: -ph.bet };
    return { ...ph, result: 'push', profit: 0 };
  });

  const insuranceProfit = hand.insurance?.taken
    ? (hand.insurance.won ? hand.insurance.amount * 2 : -hand.insurance.amount)
    : 0;

  const totalProfit = results.reduce((s, r) => s + r.profit, 0) + insuranceProfit;
  return { handResults: results, insuranceProfit, totalProfit };
}

/** Actualiza la racha del juego después de resolver una mano (para hands.current_streak_before_hand de la SIGUIENTE mano). */
export function updateStreak(game, totalProfit) {
  if (totalProfit > 0) {
    game.currentStreak = game.currentStreak > 0 ? game.currentStreak + 1 : 1;
  } else if (totalProfit < 0) {
    game.currentStreak = game.currentStreak < 0 ? game.currentStreak - 1 : -1;
  }
  // profit === 0 (push puro): la racha no cambia
}
