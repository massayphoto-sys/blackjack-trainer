// strategy.js — Tabla de estrategia básica (mazo promedio, 6 barajas,
// dealer se planta en 17, DAS permitido) + desviaciones por conteo
// verdadero (true count) tipo "Illustrious 18".
//
// IMPORTANTE: esta tabla es específica de un conjunto de reglas (ver
// nota de rule_sets en la memoria del proyecto). Si más adelante se
// agregan variantes (8 barajas, 17 blando distinto, etc.), este archivo
// debe convertirse en una de varias tablas seleccionables — por ahora
// solo existe la variante "clásica".

// Acciones posibles
export const ACTIONS = {
  HIT: 'hit',
  STAND: 'stand',
  DOUBLE: 'double',
  SPLIT: 'split',
  SURRENDER: 'surrender',
};

const DEALER_COLS = ['2','3','4','5','6','7','8','9','10','A'];

function row(...vals) {
  const r = {};
  DEALER_COLS.forEach((c, i) => { r[c] = vals[i]; });
  return r;
}

const H = ACTIONS.HIT, S = ACTIONS.STAND, D = ACTIONS.DOUBLE, SP = ACTIONS.SPLIT;

// Manos duras (hard totals) 8 a 17 (8 y menos siempre H, 17+ siempre S)
const HARD = {
  8:  row(H,H,H,H,H,H,H,H,H,H),
  9:  row(H,D,D,D,D,H,H,H,H,H),
  10: row(D,D,D,D,D,D,D,D,H,H),
  11: row(D,D,D,D,D,D,D,D,D,D),
  12: row(H,H,S,S,S,H,H,H,H,H),
  13: row(S,S,S,S,S,H,H,H,H,H),
  14: row(S,S,S,S,S,H,H,H,H,H),
  15: row(S,S,S,S,S,H,H,H,H,H),
  16: row(S,S,S,S,S,H,H,H,H,H),
};

// Manos suaves (con As contado como 11) — A-2 a A-9
const SOFT = {
  2: row(H,H,D,D,D,H,H,H,H,H), // A-2
  3: row(H,H,D,D,D,H,H,H,H,H), // A-3
  4: row(H,H,D,D,D,H,H,H,H,H), // A-4
  5: row(H,H,D,D,D,H,H,H,H,H), // A-5
  6: row(H,H,D,D,D,H,H,H,H,H), // A-6
  7: row(S,D,D,D,D,S,S,H,H,H), // A-7
  8: row(S,S,S,S,S,S,S,S,S,S), // A-8
  9: row(S,S,S,S,S,S,S,S,S,S), // A-9
};

// Pares
const PAIRS = {
  2:  row(H,H,SP,SP,SP,SP,H,H,H,H),   // 2-2
  3:  row(H,H,SP,SP,SP,SP,H,H,H,H),   // 3-3
  4:  row(H,H,H,H,H,H,H,H,H,H),       // 4-4
  5:  row(D,D,D,D,D,D,D,D,H,H),       // 5-5 (tratar como duro 10)
  6:  row(SP,SP,SP,SP,SP,H,H,H,H,H),  // 6-6
  7:  row(SP,SP,SP,SP,SP,SP,H,H,H,H), // 7-7
  8:  row(SP,SP,SP,SP,SP,SP,SP,SP,SP,SP), // 8-8
  9:  row(SP,SP,SP,SP,SP,S,SP,SP,S,S),    // 9-9
  10: row(S,S,S,S,S,S,S,S,S,S),       // 10-10
  A:  row(SP,SP,SP,SP,SP,SP,SP,SP,SP,SP), // A-A
};

/**
 * Devuelve la acción óptima según la tabla básica de mazo promedio.
 * handType: 'hard' | 'soft' | 'pair'
 * key: total (para hard/soft) o rango (para pair, ej. '8', 'A')
 * dealerUpcard: '2'..'10','A' (10/J/Q/K se normalizan a '10' antes de llamar)
 */
export function basicStrategyAction(handType, key, dealerUpcard) {
  if (handType === 'pair') return PAIRS[key]?.[dealerUpcard] ?? null;
  if (handType === 'soft') {
    if (key >= 9) return S; // A-9, A-10(=blackjack) siempre se planta
    return SOFT[key]?.[dealerUpcard] ?? null;
  }
  // hard
  if (key <= 8) return H;
  if (key >= 17) return S;
  return HARD[key]?.[dealerUpcard] ?? null;
}

/**
 * Desviaciones por conteo verdadero (Illustrious 18 y variantes más
 * comunes). Cada entrada define: bajo qué situación, a partir de qué
 * true_count la acción óptima cambia respecto a la tabla básica.
 *
 * direction: 'gte' (>=) o 'lte' (<=) — hacia qué lado del umbral aplica.
 */
export const DEVIATIONS = [
  { handType: 'hard', key: 16, dealer: '10', threshold: 0,  direction: 'gte', action: S,  note: '16 vs 10: plantarse si true count >= 0' },
  { handType: 'hard', key: 15, dealer: '10', threshold: 4,  direction: 'gte', action: S,  note: '15 vs 10: plantarse si true count >= +4' },
  { handType: 'hard', key: 12, dealer: '3',  threshold: 2,  direction: 'gte', action: S,  note: '12 vs 3: plantarse si true count >= +2' },
  { handType: 'hard', key: 12, dealer: '2',  threshold: 3,  direction: 'gte', action: S,  note: '12 vs 2: plantarse si true count >= +3' },
  { handType: 'hard', key: 10, dealer: '10', threshold: 4,  direction: 'gte', action: D,  note: '10 vs 10: doblar si true count >= +4' },
  { handType: 'hard', key: 10, dealer: 'A',  threshold: 3,  direction: 'gte', action: D,  note: '10 vs A: doblar si true count >= +3' },
  { handType: 'hard', key: 9,  dealer: '2',  threshold: 1,  direction: 'gte', action: D,  note: '9 vs 2: doblar si true count >= +1' },
  { handType: 'hard', key: 9,  dealer: '7',  threshold: 3,  direction: 'gte', action: D,  note: '9 vs 7: doblar si true count >= +3' },
  { handType: 'pair', key: '10', dealer: '5', threshold: 5, direction: 'gte', action: SP, note: '10-10 vs 5: dividir si true count >= +5' },
  { handType: 'pair', key: '10', dealer: '6', threshold: 4, direction: 'gte', action: SP, note: '10-10 vs 6: dividir si true count >= +4' },
  { handType: 'insurance', key: null, dealer: 'A', threshold: 3, direction: 'gte', action: 'insurance', note: 'Insurance: aceptar si true count >= +3' },
];

/**
 * Dada la situación y el true count actual, devuelve la acción
 * "exacta" (aplicando desviaciones si corresponde) y si hubo desviación
 * respecto a la tabla básica.
 */
export function exactOptimalAction({ handType, key, dealerUpcard, trueCount }) {
  const baseAction = handType === 'insurance'
    ? ACTIONS.HIT /* placeholder, insurance se maneja aparte */
    : basicStrategyAction(handType, key, dealerUpcard);

  const dev = DEVIATIONS.find(d =>
    d.handType === handType &&
    String(d.key) === String(key) &&
    d.dealer === dealerUpcard
  );

  if (!dev) return { action: baseAction, deviated: false };

  const crossed = dev.direction === 'gte' ? trueCount >= dev.threshold : trueCount <= dev.threshold;
  if (crossed && dev.action !== baseAction) {
    return { action: dev.action, deviated: true, rule: dev.note };
  }
  return { action: baseAction, deviated: false };
}

/** Normaliza 10/J/Q/K a '10' para indexar la tabla por carta del dealer. */
export function normalizeDealerUpcard(rank) {
  return ['10','J','Q','K'].includes(rank) ? '10' : rank;
}
