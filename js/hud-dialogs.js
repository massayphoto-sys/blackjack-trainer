function openHudDialog({ icon, title, subtitle, body, confirmLabel, onConfirm }) {
  document.querySelector('.hud-dialog-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'hud-dialog-backdrop';
  backdrop.innerHTML = `
    <section class="hud-dialog" role="dialog" aria-modal="true" aria-labelledby="hudDialogTitle">
      <button class="hud-dialog-close" type="button" data-dialog-close aria-label="Cerrar">×</button>
      <div class="hud-dialog-icon" aria-hidden="true">${icon}</div>
      <div class="hud-dialog-heading"><h2 id="hudDialogTitle">${title}</h2><p>${subtitle}</p></div>
      <div class="hud-dialog-body">${body}</div>
      <p class="hud-dialog-error" data-dialog-error hidden></p>
      <div class="hud-dialog-actions">
        <button class="hud-dialog-cancel" type="button" data-dialog-close>Cancelar</button>
        <button class="hud-dialog-confirm" type="button" data-dialog-confirm>${confirmLabel}</button>
      </div>
    </section>`;

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    backdrop.classList.add('is-closing');
    window.setTimeout(() => backdrop.remove(), 110);
  };
  const showError = message => {
    const error = backdrop.querySelector('[data-dialog-error]');
    error.textContent = message;
    error.hidden = false;
  };
  const onKeydown = event => { if (event.key === 'Escape') close(); };
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop || event.target.closest('[data-dialog-close]')) close();
  });
  backdrop.querySelector('[data-dialog-confirm]').addEventListener('click', () => {
    if (onConfirm(backdrop, showError) !== false) close();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  backdrop.querySelector('input')?.focus();
  return backdrop;
}

export function openBuyChipsDialog(controller) {
  const dialog = openHudDialog({
    icon: '<span class="dialog-chip">♛</span>',
    title: 'Agregar fichas',
    subtitle: 'Elige una cantidad o escribe un monto personalizado.',
    body: `
      <div class="hud-dialog-presets" aria-label="Cantidades rápidas">
        ${[100, 500, 1000, 5000].map(amount => `<button type="button" data-chip-amount="${amount}">+${amount.toLocaleString('es-ES')}</button>`).join('')}
      </div>
      <label class="hud-dialog-field"><span>Cantidad de fichas</span><span class="hud-dialog-input-wrap"><b>♛</b><input data-chip-input type="number" min="1" step="10" inputmode="numeric" value="100"></span></label>`,
    confirmLabel: 'Agregar fichas',
    onConfirm: (root, showError) => {
      const amount = Number(root.querySelector('[data-chip-input]').value);
      if (!Number.isFinite(amount) || amount <= 0) {
        showError('Escribe una cantidad mayor que cero.');
        return false;
      }
      controller.buyChips(Math.floor(amount));
      return true;
    },
  });
  dialog.querySelectorAll('[data-chip-amount]').forEach(button => {
    button.addEventListener('click', () => {
      dialog.querySelector('[data-chip-input]').value = button.dataset.chipAmount;
      dialog.querySelectorAll('[data-chip-amount]').forEach(item => item.classList.toggle('is-selected', item === button));
    });
  });
}

export function openLimitsDialog(controller) {
  openHudDialog({
    icon: '⚙',
    title: 'Límites de la mesa',
    subtitle: 'Define el rango permitido para tus apuestas.',
    body: `
      <div class="hud-dialog-limit-grid">
        <label class="hud-dialog-field"><span>Apuesta mínima</span><span class="hud-dialog-input-wrap"><b>$</b><input data-min-bet type="number" min="1" step="1" inputmode="numeric" value="${controller.minimumBet}"></span></label>
        <label class="hud-dialog-field"><span>Apuesta máxima</span><span class="hud-dialog-input-wrap"><b>$</b><input data-max-bet type="number" min="1" step="1" inputmode="numeric" value="${controller.maximumBet}"></span></label>
      </div>
      <div class="hud-dialog-note"><span>♠</span> La apuesta máxima debe ser mayor o igual a la mínima.</div>`,
    confirmLabel: 'Guardar límites',
    onConfirm: (root, showError) => {
      const minimum = Number(root.querySelector('[data-min-bet]').value);
      const maximum = Number(root.querySelector('[data-max-bet]').value);
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
        showError('Revisa los límites: el máximo no puede ser menor que el mínimo.');
        return false;
      }
      controller.setTableLimits(Math.floor(minimum), Math.floor(maximum));
      return true;
    },
  });
}
