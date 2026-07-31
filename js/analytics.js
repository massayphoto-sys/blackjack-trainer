// analytics.js — Cálculo de la composición REAL de cartas restantes en
// el zapato (no una aproximación por rangos), conteo Hi-Lo estándar, y
// comparación entre la decisión del jugador y la óptima exacta.
//
// Esto es lo que permite evaluar el criterio del jugador con precisión
// matemática, según lo discutido: no basta con el true_count resumido
// para auditar — se guarda también la composición exacta por rango.

import { RANKS, buildShoe } from './deck.js';

// Valores Hi-Lo: 2-6 = +1, 7-9 = 0, 10/J/Q/K/A = -1
const HI_LO_VALUE = {
  '2':1,'3':1,'4':1,'5':1,'6':1,
  '7':0,'8':0,'9':0,
  '10':-1,'J':-1,'Q':-1,'K':-1,'A':-1
};

/**
 * Composición completa de un zapato de N barajas antes de repartir nada.
 * Ej. para 6 barajas: { '2':24, '3':24, ..., '10':96, 'A':24 }
 * ('10' agrupa 10/J/Q/K, 24*4=96)
 */
export function fullShoeComposition(numDecks = 6) {
  const comp = {};
  for (const r of RANKS) {
    const key = ['10','J','Q','K'].includes(r) ? '10' : r;
    comp[key] = (comp[key] || 0) + 4 * numDecks;
  }
  return comp;
}

/**
 * Dado el shoe (con dealtSequence = cartas ya repartidas/quemadas hasta
 * ahora) y el número de barajas original, calcula cuántas cartas de
 * cada rango quedan realmente. Esto es remaining_composition.
 */
export function computeRemainingComposition(shoe, numDecks = 6) {
  const comp = fullShoeComposition(numDecks);
  for (const card of shoe.dealtSequence) {
    const key = ['10','J','Q','K'].includes(card.rank) ? '10' : card.rank;
    comp[key] = Math.max(0, comp[key] - 1);
  }
  return comp;
}

/** Total de cartas restantes según una composición. */
export function totalRemaining(composition) {
  return Object.values(composition).reduce((a, b) => a + b, 0);
}

/**
 * Running count Hi-Lo acumulado sobre las cartas ya repartidas.
 * (Nota: esto asume que el conteo cuenta también las cartas quemadas,
 * lo cual NO es lo que haría un jugador humano real —humano no ve la
 * quemada— pero el sistema, con fines de auditoría interna, sí conoce
 * la carta quemada. Si se quiere simular el conteo "humano" real, hay
 * que excluir shoe.burnedCards de este cálculo.)
 */
export function computeRunningCount(dealtSequence, { excludeBurned = [] } = {}) {
  const excludedIds = new Set(excludeBurned.map(c => c.id));
  let count = 0;
  for (const card of dealtSequence) {
    if (excludedIds.has(card.id)) continue;
    count += HI_LO_VALUE[card.rank] ?? 0;
  }
  return count;
}

/** True count = running count / mazos restantes (redondeando mazos hacia arriba a 0.5 más cercano). */
export function computeTrueCount(runningCount, cardsRemaining) {
  const decksRemaining = Math.max(cardsRemaining / 52, 0.5); // evita división por casi-cero al final del zapato
  return Math.round((runningCount / decksRemaining) * 10) / 10;
}

/**
 * Probabilidad de que la próxima carta sea "baja" (2-6), "media" (7-9)
 * o "alta" (10/J/Q/K/A), según la composición exacta restante.
 * Esto es lo que se usa INTERNAMENTE para evaluar al jugador — no se
 * le muestra al usuario en pantalla (eso sería contar cartas de forma
 * asistida, distinto del objetivo de entrenar su propio criterio).
 */
export function nextCardProbabilities(composition) {
  const total = totalRemaining(composition);
  if (total === 0) return { low: 0, mid: 0, high: 0 };
  const low = ['2','3','4','5','6'].reduce((s, r) => s + (composition[r] || 0), 0);
  const mid = ['7','8','9'].reduce((s, r) => s + (composition[r] || 0), 0);
  const high = ['10','A'].reduce((s, r) => s + (composition[r] || 0), 0);
  return {
    low: Math.round((low / total) * 1000) / 10,
    mid: Math.round((mid / total) * 1000) / 10,
    high: Math.round((high / total) * 1000) / 10,
  };
}

/**
 * Registra, para una decisión dada, todo el contexto analítico que se
 * guardará en la tabla `decisions`: composición restante, true count,
 * y (a través de strategy.exactOptimalAction, llamado por game.js) si
 * hubo desviación de la tabla básica.
 */
export function buildDecisionAnalytics(shoe, numDecks = 6, burnedCards = []) {
  const composition = computeRemainingComposition(shoe, numDecks);
  const remaining = totalRemaining(composition);
  const runningCount = computeRunningCount(shoe.dealtSequence, { excludeBurned: burnedCards });
  const trueCount = computeTrueCount(runningCount, remaining);
  return {
    remaining_composition: composition,
    cards_remaining: remaining,
    running_count: runningCount,
    true_count: trueCount,
    probabilities: nextCardProbabilities(composition),
  };
}
