// ev-engine.js — Cálculo real de Expected Value (EV) por acción, usando
// la composición exacta de cartas restantes del zapato en el momento de
// la decisión. Reemplaza el heurístico provisional que había en game.js.
//
// SIMPLIFICACIÓN DECLARADA (ver explicación al usuario en el chat):
// la composición del zapato se trata como FIJA durante el cálculo de una
// sola decisión — no se resta cartas hipotéticas que el dealer "podría"
// sacar en el futuro simulado. Es la misma premisa que ya usa todo el
// sistema de conteo de cartas (el true_count asume que la composición
// actual representa el resto del zapato). El error que introduce es
// mínimo con un zapato de 200-300 cartas.
//
// Split se calcula como una APROXIMACIÓN (promedio de la EV de cada mano
// resultante tras una carta adicional) — no modela la correlación exacta
// entre los sorteos de ambas manos. Está marcado explícitamente abajo.

const RANKS = ['2','3','4','5','6','7','8','9','10','A'];

function rankValue(rank) {
  if (rank === 'A') return 11;
  if (rank === '10') return 10;
  return Number(rank);
}

function totalOf(composition) {
  return Object.values(composition).reduce((a, b) => a + b, 0);
}

/** Dado un estado (total, esSuave) y una carta nueva, devuelve el nuevo estado. */
function addCardToState(total, isSoft, rank) {
  let newTotal = total + rankValue(rank);
  let newIsSoft = isSoft || rank === 'A';
  if (newTotal > 21 && newIsSoft) {
    newTotal -= 10;
    newIsSoft = false; // como máximo un As cuenta como 11 en una mano válida
  }
  return { total: newTotal, isSoft: newIsSoft };
}

function zeroDist() {
  return { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 };
}

/**
 * Distribución de resultados finales del dealer (17,18,19,20,21,bust),
 * promediando sobre todas las cartas tapadas posibles, usando la
 * composición dada como fija durante todo el cálculo.
 */
export function dealerFinalDistribution(composition, dealerUpcardRank) {
  const total = totalOf(composition);
  if (total === 0) return zeroDist();

  const memo = new Map();
  function distFromState(t, soft) {
    const key = `${t}_${soft}`;
    if (memo.has(key)) return memo.get(key);
    let dist;
    if (t > 21) {
      dist = zeroDist();
      dist.bust = 1;
    } else if (t >= 17) {
      dist = zeroDist();
      dist[t] = 1;
    } else {
      dist = zeroDist();
      for (const rank of RANKS) {
        const count = composition[rank] || 0;
        if (count <= 0) continue;
        const p = count / total;
        const next = addCardToState(t, soft, rank);
        const sub = distFromState(next.total, next.isSoft);
        for (const k in dist) dist[k] += p * sub[k];
      }
    }
    memo.set(key, dist);
    return dist;
  }

  // Promedia sobre la carta tapada desconocida, partiendo de la carta visible.
  const upStart = addCardToState(0, false, dealerUpcardRank);
  const result = zeroDist();
  for (const holeRank of RANKS) {
    const count = composition[holeRank] || 0;
    if (count <= 0) continue;
    const p = count / total;
    const start = addCardToState(upStart.total, upStart.isSoft, holeRank);
    const sub = distFromState(start.total, start.isSoft);
    for (const k in result) result[k] += p * sub[k];
  }
  return result;
}

/** EV de plantarse en playerTotal, dada la distribución de resultados del dealer. */
export function standEV(playerTotal, dealerDist) {
  let ev = 0;
  for (const outcome in dealerDist) {
    const p = dealerDist[outcome];
    if (p === 0) continue;
    if (outcome === 'bust') { ev += p * 1; continue; }
    const dealerTotal = Number(outcome);
    if (playerTotal > dealerTotal) ev += p * 1;
    else if (playerTotal < dealerTotal) ev += p * -1;
    // empate: ev += 0
  }
  return ev;
}

/**
 * EV óptima de una mano (jugando de forma óptima: mejor entre plantarse
 * y pedir en cada punto siguiente), dada la composición fija y la
 * distribución de resultados del dealer ya calculada.
 */
export function bestHandEV(playerTotal, playerIsSoft, composition, dealerDist) {
  const total = totalOf(composition);
  const memo = new Map();

  function evFromState(t, soft) {
    if (t > 21) return -1; // bust
    const key = `${t}_${soft}`;
    if (memo.has(key)) return memo.get(key);

    const evStand = standEV(t, dealerDist);
    let evHit = 0;
    if (total > 0) {
      for (const rank of RANKS) {
        const count = composition[rank] || 0;
        if (count <= 0) continue;
        const p = count / total;
        const next = addCardToState(t, soft, rank);
        evHit += p * evFromState(next.total, next.isSoft);
      }
    } else {
      evHit = evStand;
    }
    const best = Math.max(evStand, evHit);
    memo.set(key, best);
    return best;
  }

  return evFromState(playerTotal, playerIsSoft);
}

/** EV de doblar: una carta más, y se fuerza a plantarse. */
export function doubleEV(playerTotal, playerIsSoft, composition, dealerDist) {
  const total = totalOf(composition);
  if (total === 0) return standEV(playerTotal, dealerDist) * 2;
  let ev = 0;
  for (const rank of RANKS) {
    const count = composition[rank] || 0;
    if (count <= 0) continue;
    const p = count / total;
    const next = addCardToState(playerTotal, playerIsSoft, rank);
    const outcomeEV = next.total > 21 ? -1 : standEV(next.total, dealerDist);
    ev += p * outcomeEV;
  }
  return ev * 2; // el doble de la apuesta
}

/**
 * EV de dividir — APROXIMACIÓN, no exacta. Calcula la EV de cada mano
 * resultante tras UNA carta adicional (promediada sobre las cartas
 * posibles), pero no modela la correlación exacta entre lo que sale en
 * la primera mano dividida y lo que queda disponible para la segunda.
 * En un zapato de 200+ cartas el efecto es pequeño, pero es una
 * aproximación declarada, no un cálculo exacto como stand/hit/double.
 */
export function approximateSplitEV(pairRank, composition, dealerDist) {
  const total = totalOf(composition);
  if (total === 0) return 0;
  let evPerHand = 0;
  for (const rank of RANKS) {
    const count = composition[rank] || 0;
    if (count <= 0) continue;
    const p = count / total;
    const start = addCardToState(0, false, pairRank);
    const next = addCardToState(start.total, start.isSoft, rank);
    evPerHand += p * bestHandEV(next.total, next.isSoft, composition, dealerDist);
  }
  return evPerHand * 2; // dos manos, cada una con su propia apuesta
}

/**
 * Punto de entrada principal: calcula la EV de cada acción legal y
 * devuelve cuál es la óptima según el cálculo exacto/aproximado, junto
 * con el detalle de cada EV para poder guardarlo en `decisions`.
 */
export function computeExactEV({ playerTotal, playerIsSoft, isPair, pairRank, composition, dealerUpcardRank, legalActions }) {
  const dealerDist = dealerFinalDistribution(composition, dealerUpcardRank);

  const evByAction = {};
  if (legalActions.includes('stand')) evByAction.stand = standEV(playerTotal, dealerDist);
  if (legalActions.includes('hit')) evByAction.hit = bestHandEV(playerTotal, playerIsSoft, composition, dealerDist);
  if (legalActions.includes('double')) evByAction.double = doubleEV(playerTotal, playerIsSoft, composition, dealerDist);
  if (legalActions.includes('split') && isPair) evByAction.split = approximateSplitEV(pairRank, composition, dealerDist);

  let bestAction = null;
  let bestEV = -Infinity;
  for (const action in evByAction) {
    if (evByAction[action] > bestEV) {
      bestEV = evByAction[action];
      bestAction = action;
    }
  }

  return { evByAction, bestAction, bestEV };
}
