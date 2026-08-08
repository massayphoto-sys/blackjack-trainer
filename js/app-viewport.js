// Keeps the app at a portrait 9:16 minimum. Taller screens extend naturally;
// shorter screens scale the complete interface as one centered unit.
(() => {
  const app = document.querySelector('.app-viewport');
  if (!app) return;

  const MIN_APP_WIDTH = 390;
  const MAX_APP_WIDTH = 480;
  const MIN_APP_HEIGHT = 930;
  const MIN_HEIGHT_PER_WIDTH = 16 / 9;
  let resizeFrame = 0;

  function calculate(viewportWidth, viewportHeight, contentMinimumHeight = MIN_APP_HEIGHT) {
    const availableWidth = Math.max(1, Number(viewportWidth) || 1);
    const availableHeight = Math.max(1, Number(viewportHeight) || 1);
    // Keep one stable phone layout even on very narrow devices. The whole
    // 390px design is scaled down instead of allowing its HUD text to wrap
    // into extra rows and push the controls below the visible canvas.
    const width = Math.min(MAX_APP_WIDTH, Math.max(MIN_APP_WIDTH, availableWidth));
    // The complete playing state (cards + wager + five actions + bottom nav)
    // needs a little more vertical room than bare 9:16 at phone widths.
    const minimumHeight = Math.max(contentMinimumHeight, width * MIN_HEIGHT_PER_WIDTH);
    const widthScale = Math.min(1, availableWidth / width);
    const scale = Math.min(widthScale, availableHeight / minimumHeight);
    const height = Math.max(minimumHeight, availableHeight / scale);
    return { width, height, scale, fittedWidth: width * scale, fittedHeight: height * scale };
  }

  function applyFit() {
    resizeFrame = 0;
    const visualViewport = window.visualViewport;
    const viewportWidth = visualViewport?.width || document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = visualViewport?.height || document.documentElement.clientHeight || window.innerHeight;
    const fit = calculate(viewportWidth, viewportHeight);

    app.style.width = `${fit.width}px`;
    app.style.height = `${fit.height}px`;
    app.style.left = `${(visualViewport?.offsetLeft || 0) + (viewportWidth / 2)}px`;
    app.style.top = `${visualViewport?.offsetTop || 0}px`;
    app.style.setProperty('--app-scale', String(fit.scale));
    app.classList.toggle('is-uniformly-scaled', fit.scale < .9999);
    document.documentElement.dataset.appFit = fit.scale < .9999 ? 'scaled' : 'natural';
  }

  function scheduleFit() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(applyFit);
  }

  window.BlackjackViewportFit = Object.freeze({ calculate, refresh: scheduleFit });
  window.addEventListener('resize', scheduleFit, { passive: true });
  window.addEventListener('orientationchange', scheduleFit, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleFit, { passive: true });
  applyFit();
})();
