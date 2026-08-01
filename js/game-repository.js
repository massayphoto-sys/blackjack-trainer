// game-repository.js — Toda la comunicación con Supabase para el motor
// de juego (game.js). game.js y sus módulos no importan `supabase`
// directamente; todo pasa por aquí, para mantener la separación entre
// reglas del juego y persistencia.

import { supabase } from './supabase.js';
import { serializeShoeForStorage } from './deck.js';

/** Obtiene el perfil del usuario autenticado (creado automáticamente por trigger al registrarse). */
export async function getMyProfile() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('No hay sesión activa.');

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data;
}

/** Guarda el nombre a mostrar del usuario (paso de onboarding tras el primer login). */
export async function updateDisplayName(displayName) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('No hay sesión activa.');

  const { data, error } = await supabase
    .from('profiles')
    .update({ display_name: displayName, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Crea una nueva sesión de entrenamiento para el usuario autenticado. */
export async function createTrainingSession({ bankrollStart, minimumBet, maximumBet, gameMode = 'heads_up' }) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('No hay sesión activa.');

  const { data, error } = await supabase
    .from('training_sessions')
    .insert({
      profile_id: user.id,
      bankroll_start: bankrollStart,
      minimum_bet: minimumBet,
      maximum_bet: maximumBet,
      strategy_mode: 'basic',
      training_mode: 'training',
      status: 'active',
      game_mode: gameMode,
      device_type: navigator.userAgentData?.mobile ? 'mobile' : 'desktop',
      browser_name: navigator.userAgent.slice(0, 100),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Persiste un zapato ya jugado (o en curso, para ir actualizando penetración). */
export async function saveShoe({ id, sessionId, shoeNumber, shoe, endedAt }) {
  const payload = {
    session_id: sessionId,
    shoe_number: shoeNumber,
    full_card_sequence: serializeShoeForStorage(shoe),
    player_cut_position: shoe.playerCutPosition,
    cut_card_position: shoe.cutCardPosition,
    penetration_pct: shoe.penetrationPct,
    total_cards: shoe.totalCards,
    ended_at: endedAt ?? null,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { data, error } = await supabase.from('shoes').update(payload).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('shoes').insert(payload).select().single();
  if (error) throw error;
  return data;
}

/** Inserta la mano ya resuelta, junto con sus decisiones y los errores (mistakes) detectados. */
export async function saveResolvedHand({ sessionId, shoeId, hand, handResults, totalProfit, seatNumber = 1, globalHandNumber }) {
  const { data: handRow, error: handError } = await supabase
    .from('hands')
    .insert({
      session_id: sessionId,
      shoe_id: shoeId,
      hand_number: globalHandNumber, // continuo a través de toda la sesión (único junto con session_id)
      hand_number_in_shoe: hand.handNumberInShoe,
      shoe_number: hand.shoeNumber,
      seat_number: seatNumber,
      bet_amount: hand.playerHands[0].bet,
      bankroll_before_hand: hand.bankrollBeforeHand,
      previous_bet_amount: hand.previousBetAmount,
      current_streak_before_hand: hand.currentStreakBeforeHand,
      hands_played_in_session_so_far: hand.handsPlayedInSessionSoFar,
      dealer_upcard: hand.dealerUpcard,
      player_initial_cards: hand.playerHands[0].cards.slice(0, 2).map(c => `${c.rank}${c.suit}`),
      dealer_initial_cards: hand.dealerCards.slice(0, 2).map(c => `${c.rank}${c.suit}`),
      final_player_hands: handResults.map(r => r.cards.map(c => `${c.rank}${c.suit}`)),
      final_dealer_cards: hand.dealerCards.map(c => `${c.rank}${c.suit}`),
      running_count: hand.decisions.at(-1)?.runningCount ?? null,
      true_count: hand.decisions.at(-1)?.trueCount ?? null,
      result: handResults.length === 1 ? handResults[0].result : null, // manos divididas: resultado detallado vive en cada decisión/hand hija si se modela así
      profit: totalProfit,
      ev_loss: hand.decisions.reduce((s, d) => s + (d.evLoss || 0), 0),
      started_at: hand.startedAt,
      ended_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (handError) throw handError;

  if (hand.decisions.length > 0) {
    const decisionRows = hand.decisions.map((d, i) => ({
      hand_id: handRow.id,
      decision_number: i + 1,
      player_hand_index: d.playerHandIndex,
      player_cards: d.playerCards.map(c => `${c.rank}${c.suit}`),
      dealer_upcard: d.dealerUpcard,
      player_total: d.playerTotal,
      hand_type: d.handType,
      available_actions: d.availableActions,
      player_action: d.playerAction,
      expected_action: d.expectedAction,
      is_correct: d.isCorrect,
      ev_loss: d.evLoss,
      remaining_composition: d.remainingComposition,
      ev_optimal_action_exact: d.evOptimalActionExact,
      optimal_action_exact: d.optimalActionExact,
      deviated_from_basic_table: d.deviatedFromBasicTable,
      running_count: d.runningCount,
      true_count: d.trueCount,
    }));

    const { data: insertedDecisions, error: decError } = await supabase
      .from('decisions')
      .insert(decisionRows)
      .select();
    if (decError) throw decError;

    // Cada decisión incorrecta genera un registro en `mistakes` para
    // poder categorizar y reportar patrones de error.
    const mistakeRows = insertedDecisions
      .filter(d => !d.is_correct)
      .map(d => ({
        decision_id: d.id,
        error_type: `${d.hand_type}_${d.player_action}_instead_of_${d.expected_action}`,
        error_category: categorizeError(d.hand_type),
        severity: d.ev_loss >= 0.1 ? 'high' : 'medium',
        player_action: d.player_action,
        expected_action: d.expected_action,
        player_total: d.player_total,
        dealer_upcard: d.dealer_upcard,
        ev_loss: d.ev_loss,
      }));

    if (mistakeRows.length > 0) {
      const { error: mistakeError } = await supabase.from('mistakes').insert(mistakeRows);
      if (mistakeError) throw mistakeError;
    }
  }

  return handRow;
}

function categorizeError(handType) {
  if (handType === 'pair') return 'pair_splitting';
  if (handType === 'soft') return 'soft_total';
  if (handType === 'hard') return 'hard_total';
  return 'other';
}

/** Actualiza los totales acumulados de la sesión (llamar tras cada mano o al cerrar sesión). */
export async function updateSessionTotals(sessionId, totals) {
  const { error } = await supabase
    .from('training_sessions')
    .update({
      total_hands: totals.totalHands,
      correct_decisions: totals.correctDecisions,
      incorrect_decisions: totals.incorrectDecisions,
      total_profit: totals.totalProfit,
      total_ev_loss: totals.totalEvLoss,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw error;
}

/** Cierra la sesión de entrenamiento. */
export async function endTrainingSession(sessionId, bankrollEnd) {
  const { error } = await supabase
    .from('training_sessions')
    .update({ status: 'completed', ended_at: new Date().toISOString(), bankroll_end: bankrollEnd })
    .eq('id', sessionId);
  if (error) throw error;
}

/** Consulta el indicador del jugador (vista player_decision_stats) para mostrar reportes. */
export async function getPlayerStats() {
  const { data, error } = await supabase.from('player_decision_stats').select('*');
  if (error) throw error;
  return data;
}

/**
 * Consulta los errores (mistakes) más recientes del usuario, opcionalmente
 * filtrados por categoría (pair_splitting/soft_total/hard_total/other) —
 * para el detalle que se abre al hacer clic en una fila del reporte.
 */
export async function getMyMistakes({ errorCategory = null, limit = 30 } = {}) {
  let query = supabase
    .from('mistakes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (errorCategory) query = query.eq('error_category', errorCategory);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Datos de precisión cruzados con fatiga (número de mano en la sesión) y
 * racha (rachas de victorias/derrotas antes de cada mano) — para el
 * reporte de fatiga/racha. Usa la relación decisions -> hands para traer
 * ambos campos en una sola consulta.
 */
export async function getFatigueStreakData() {
  const { data, error } = await supabase
    .from('decisions')
    .select('is_correct, ev_loss, hands(hands_played_in_session_so_far, current_streak_before_hand)');
  if (error) throw error;
  return data;
}

/** Busca una sesión de entrenamiento activa (sin cerrar) del usuario, si existe. */
export async function getActiveSession() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('No hay sesión activa.');

  const { data, error } = await supabase
    .from('training_sessions')
    .select('*')
    .eq('profile_id', user.id)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}
