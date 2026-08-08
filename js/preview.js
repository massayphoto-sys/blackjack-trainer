// Visual-testing mode is opt-in through the URL. It uses only fake in-memory
// data, so enabling it never grants access to protected Supabase data and
// never writes a session, shoe, hand, or decision to the database.
export function isPreviewMode() {
  return new URLSearchParams(window.location.search).get('preview') === '1';
}

export async function clearLegacyAppCache() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('blackjack-trainer-'))
      .map(key => caches.delete(key)));
  }
}

let nextId = 1;

export const previewRepository = {
  async createTrainingSession({ bankrollStart, minimumBet, maximumBet, gameMode }) {
    return {
      id: `preview-session-${nextId++}`,
      bankroll_start: bankrollStart,
      minimum_bet: minimumBet,
      maximum_bet: maximumBet,
      game_mode: gameMode,
      started_at: new Date().toISOString(),
    };
  },
  async getShoeCountForSession() { return 0; },
  async saveShoe() { return { id: `preview-shoe-${nextId++}` }; },
  async saveResolvedHand() { return null; },
  async updateSessionTotals() { return null; },
  async endTrainingSession() { return null; },
};

export const previewStats = [
  { hand_type: 'hard', dealer_upcard: '10', expected_action: 'hit', total_decisions: 24, correct_decisions: 13, accuracy_pct: 54, confidence_level: 'alta' },
  { hand_type: 'hard', dealer_upcard: '6', expected_action: 'stand', total_decisions: 21, correct_decisions: 17, accuracy_pct: 81, confidence_level: 'alta' },
  { hand_type: 'hard', dealer_upcard: '2', expected_action: 'stand', total_decisions: 14, correct_decisions: 12, accuracy_pct: 86, confidence_level: 'media' },
  { hand_type: 'soft', dealer_upcard: '6', expected_action: 'double', total_decisions: 12, correct_decisions: 7, accuracy_pct: 58, confidence_level: 'media' },
  { hand_type: 'soft', dealer_upcard: '9', expected_action: 'hit', total_decisions: 10, correct_decisions: 8, accuracy_pct: 80, confidence_level: 'media' },
  { hand_type: 'pair', dealer_upcard: '10', expected_action: 'split', total_decisions: 8, correct_decisions: 7, accuracy_pct: 88, confidence_level: 'baja' },
  { hand_type: 'pair', dealer_upcard: '7', expected_action: 'split', total_decisions: 9, correct_decisions: 9, accuracy_pct: 100, confidence_level: 'media' },
];

export const previewMistakes = [
  { player_total: 16, dealer_upcard: '10', player_action: 'stand', expected_action: 'hit' },
  { player_total: 13, dealer_upcard: '2', player_action: 'hit', expected_action: 'stand' },
  { player_total: 18, dealer_upcard: '6', player_action: 'stand', expected_action: 'double' },
];

export const previewFatigueRows = Array.from({ length: 48 }, (_, index) => ({
  is_correct: index % 5 !== 0 && !(index > 30 && index % 3 === 0),
  hands: {
    hands_played_in_session_so_far: index,
    current_streak_before_hand: (index % 9) - 4,
  },
}));
