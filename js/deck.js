// deck.js — Construcción, barajado y manejo del zapato (shoe).
// Responsabilidad única: producir una secuencia de cartas y llevar el
// registro exacto de qué ha salido, para que analytics.js pueda calcular
// la composición restante real en cualquier punto.

export const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
export const SUITS = ['♠','♥','♦','♣'];

// Valor de blackjack por rango (10/J/Q/K valen 10)
export const RANK_VALUE = {
  '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
  '10':10,'J':10,'Q':10,'K':10,'A':11
};

/**
 * Construye un zapato de N barajas completas (por defecto 6 = 312 cartas).
 * Cada carta es { rank, suit, id } — id es único dentro del zapato, útil
 * para depuración y para que full_card_sequence sea trazable.
 */
export function buildShoe(numDecks = 6) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: id++, rank, suit });
      }
    }
  }
  return cards;
}

/**
 * Fisher-Yates shuffle. Uniformemente aleatorio — nunca sesgado por
 * resultados previos. Ver nota de diseño: el barajado de un zapato nuevo
 * es independiente de todo lo que pasó en zapatos anteriores.
 */
export function shuffle(cards, rng = Math.random) {
  const arr = cards.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Aplica el corte del jugador: mueve el bloque delantero (0..cutPosition)
 * al final del mazo. No baraja, solo reordena.
 */
export function applyPlayerCut(cards, cutPosition) {
  const front = cards.slice(0, cutPosition);
  const back = cards.slice(cutPosition);
  return back.concat(front);
}

/**
 * Calcula dónde queda la carta de corte (penetración), con variación
 * aleatoria entre 17.0% y 23.0% sin jugar, redondeada a una décima —
 * tal como está documentado en las versiones anteriores del proyecto.
 */
export function computeCutCardPosition(totalCards, rng = Math.random) {
  const minUnplayed = 0.17;
  const maxUnplayed = 0.23;
  const unplayedPct = Math.round((minUnplayed + rng() * (maxUnplayed - minUnplayed)) * 1000) / 1000;
  const cutCardPosition = Math.floor(totalCards * (1 - unplayedPct));
  return { cutCardPosition, penetrationPct: Math.round((1 - unplayedPct) * 1000) / 10 };
}

/**
 * Crea un "Shoe" completo listo para jugar: construye, baraja, aplica
 * corte del jugador (posición aleatoria entre 15% y 85%), quema la
 * primera carta, y calcula la carta de corte final.
 *
 * Devuelve un objeto que además de las cartas trae todo lo necesario
 * para persistir en la tabla `shoes` de Supabase.
 */
export function createShoe({ numDecks = 6, rng = Math.random } = {}) {
  let cards = shuffle(buildShoe(numDecks), rng);

  const totalCards = cards.length;
  const playerCutPosition = Math.floor(totalCards * (0.15 + rng() * 0.70));
  cards = applyPlayerCut(cards, playerCutPosition);

  // Se quema la primera carta tras el corte
  const burned = [cards[0]];
  const drawPile = cards.slice(1);

  const { cutCardPosition, penetrationPct } = computeCutCardPosition(totalCards, rng);

  return {
    totalCards,
    playerCutPosition,
    cutCardPosition,
    penetrationPct,
    drawPile,        // cartas que quedan por repartir, en orden
    dealtSequence: burned.slice(), // secuencia completa ya "consumida" (empieza con la quemada)
    burnedCards: burned,
    cursor: 0,        // índice de la próxima carta a repartir dentro de dealtSequence una vez avance
  };
}

/**
 * Reparte una carta del shoe. Muta el shoe (drawPile/dealtSequence) y
 * devuelve la carta repartida. Si no quedan cartas, lanza error —
 * en la práctica no debería pasar porque el corte deja margen.
 */
export function dealCard(shoe) {
  if (shoe.drawPile.length === 0) {
    throw new Error('El zapato se quedó sin cartas — revisa la lógica de corte.');
  }
  const card = shoe.drawPile.shift();
  shoe.dealtSequence.push(card);
  return card;
}

/**
 * ¿Ya se llegó a la carta de corte? Se compara la cantidad de cartas
 * ya repartidas (dealtSequence.length) contra cutCardPosition.
 */
export function isPastCutCard(shoe) {
  return shoe.dealtSequence.length >= shoe.cutCardPosition;
}

/** Suma el valor de una mano de blackjack, ajustando ases (11 -> 1) si se pasa de 21. */
export function handValue(cards) {
  let total = cards.reduce((sum, c) => sum + RANK_VALUE[c.rank], 0);
  let aces = cards.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  const isSoft = cards.some(c => c.rank === 'A') && total <= 21 &&
    cards.reduce((sum, c) => sum + RANK_VALUE[c.rank], 0) !== total;
  return { total, isSoft, isBlackjack: cards.length === 2 && total === 21 };
}

/** Serializa el shoe a lo que espera la columna shoes.full_card_sequence. */
export function serializeShoeForStorage(shoe) {
  return shoe.dealtSequence.map(c => `${c.rank}${c.suit}`);
}
