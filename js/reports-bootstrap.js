// reports-bootstrap.js — Vive en reports.html. Trae player_decision_stats
// (agregado por hand_type/dealer_upcard/expected_action) y lo agrupa en
// tarjetas por categoría (duras/suaves/pares), ordenadas de peor a mejor
// precisión — lo más accionable primero. Cada fila de desglose puede
// abrirse para ver los errores (mistakes) más recientes de esa situación.

import { getCurrentSession, subscribeToAuthChanges } from './auth.js';
import { getMyProfile, getPlayerStats, getMyMistakes } from './game-repository.js';

const backButton = document.getElementById('backButton');
const reportsBody = document.getElementById('reportsBody');

const CATEGORY_LABELS = { hard: 'Manos duras', soft: 'Manos suaves', pair: 'Pares' };
const ERROR_CATEGORY_MAP = { hard: 'hard_total', soft: 'soft_total', pair: 'pair_splitting' };
const ACTION_LABELS = { hit: 'Pedir', stand: 'Plantarse', double: 'Doblar', split: 'Dividir', insurance: 'Seguro' };

function confidenceClass(level) {
  return `confidence-${level}`;
}

function pctClass(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 65) return 'mid';
  return 'low';
}

function aggregateByCategory(rows) {
  const byCategory = {};
  for (const r of rows) {
    if (!byCategory[r.hand_type]) byCategory[r.hand_type] = { total: 0, correct: 0, rows: [] };
    byCategory[r.hand_type].total += r.total_decisions;
    byCategory[r.hand_type].correct += r.correct_decisions;
    byCategory[r.hand_type].rows.push(r);
  }
  return byCategory;
}

async function loadMistakesInto(panel, category) {
  panel.innerHTML = '<div class="mistake-item">Cargando…</div>';
  try {
    const mistakes = await getMyMistakes({ errorCategory: ERROR_CATEGORY_MAP[category], limit: 10 });
    if (mistakes.length === 0) {
      panel.innerHTML = '<div class="mistake-item">No hay errores registrados en esta categoría.</div>';
      return;
    }
    panel.innerHTML = mistakes.map(m => `
      <div class="mistake-item">
        Total ${m.player_total} vs carta ${m.dealer_upcard} —
        jugaste <span class="m-action">${ACTION_LABELS[m.player_action] || m.player_action}</span>,
        lo correcto era <span class="m-expected">${ACTION_LABELS[m.expected_action] || m.expected_action}</span>
      </div>
    `).join('');
  } catch (error) {
    panel.innerHTML = `<div class="mistake-item">No se pudieron cargar los errores: ${error?.message || error}</div>`;
  }
}

function renderCategoryCard(categoryKey, agg) {
  const pct = agg.total > 0 ? Math.round((agg.correct / agg.total) * 100) : 0;
  const card = document.createElement('div');
  card.className = 'category-card';

  const sortedRows = agg.rows.slice().sort((a, b) => a.accuracy_pct - b.accuracy_pct);

  card.innerHTML = `
    <div class="cat-head" data-toggle-category>
      <div>
        <div class="cat-name">${CATEGORY_LABELS[categoryKey] || categoryKey}</div>
        <div class="cat-meta">${agg.total} decisiones</div>
      </div>
      <div class="cat-pct ${pctClass(pct)}">${pct}%</div>
    </div>
    <div class="cat-detail">
      ${sortedRows.map((r, i) => `
        <div class="breakdown-row" data-toggle-mistakes="${i}">
          <span class="vs">vs ${r.dealer_upcard}</span>
          <span class="exp">correcto: ${ACTION_LABELS[r.expected_action] || r.expected_action}</span>
          <span class="conf ${confidenceClass(r.confidence_level)}">${r.confidence_level}</span>
          <span class="pct">${r.accuracy_pct}%</span>
        </div>
        <div class="mistakes-panel" data-mistakes-panel="${i}"></div>
      `).join('')}
    </div>
  `;

  const head = card.querySelector('[data-toggle-category]');
  const detail = card.querySelector('.cat-detail');
  head.addEventListener('click', () => detail.classList.toggle('open'));

  card.querySelectorAll('[data-toggle-mistakes]').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.dataset.toggleMistakes;
      const panel = card.querySelector(`[data-mistakes-panel="${idx}"]`);
      const opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if (opening && !panel.dataset.loaded) {
        panel.dataset.loaded = '1';
        loadMistakesInto(panel, categoryKey);
      }
    });
  });

  return card;
}

async function loadReport() {
  try {
    const stats = await getPlayerStats();
    if (!stats || stats.length === 0) {
      reportsBody.innerHTML = '<div class="empty-state">Todavía no tienes suficientes manos jugadas para generar un reporte. Sigue entrenando y vuelve aquí.</div>';
      return;
    }

    const totalDecisions = stats.reduce((s, r) => s + r.total_decisions, 0);
    const totalCorrect = stats.reduce((s, r) => s + r.correct_decisions, 0);
    const overallPct = totalDecisions > 0 ? Math.round((totalCorrect / totalDecisions) * 100) : 0;

    const byCategory = aggregateByCategory(stats);
    const order = ['hard', 'soft', 'pair'];
    const sortedCategories = Object.keys(byCategory).sort((a, b) => {
      const pctA = byCategory[a].total > 0 ? byCategory[a].correct / byCategory[a].total : 1;
      const pctB = byCategory[b].total > 0 ? byCategory[b].correct / byCategory[b].total : 1;
      return pctA - pctB; // peor precisión primero
    });

    reportsBody.innerHTML = '';

    const overallCard = document.createElement('div');
    overallCard.className = 'overall-card';
    overallCard.innerHTML = `
      <div class="big">${overallPct}%</div>
      <div class="sub">${totalCorrect} / ${totalDecisions} decisiones correctas</div>
      <div class="note">Toca una categoría para ver el desglose por carta del dealer, y una fila del desglose para ver los errores específicos.</div>
    `;
    reportsBody.appendChild(overallCard);

    sortedCategories.forEach(cat => {
      reportsBody.appendChild(renderCategoryCard(cat, byCategory[cat]));
    });
  } catch (error) {
    console.error('No se pudo cargar el reporte:', error);
    reportsBody.innerHTML = `<div class="empty-state">No se pudo cargar el reporte: ${error?.message || error}</div>`;
  }
}

if (backButton) {
  backButton.addEventListener('click', () => { window.location.href = './game.html'; });
}

async function guardSession(session) {
  const active = Boolean(session?.user);
  if (!active) { window.location.href = './index.html'; return; }
  try {
    const profile = await getMyProfile();
    if (!profile?.display_name) { window.location.href = './index.html'; return; }
    loadReport();
  } catch (error) {
    console.error('No se pudo verificar el perfil:', error);
  }
}

(async function init() {
  try {
    const session = await getCurrentSession();
    await guardSession(session);
    subscribeToAuthChanges(guardSession);
  } catch (error) {
    console.error('reports-bootstrap init error:', error);
  }
})();
