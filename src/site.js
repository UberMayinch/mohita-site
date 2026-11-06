// Platform filter + "Show more" for the content grid. Without JS every card simply shows.
(() => {
  const grid = document.querySelector('[data-grid]');
  if (!grid) return;
  const cards = [...grid.children];
  const chips = document.querySelectorAll('[data-filter]');
  const more = document.querySelector('[data-more]');
  const PAGE = 9;
  let filter = 'all';
  let limit = PAGE;

  function render() {
    let total = 0;
    for (const card of cards) {
      const match = filter === 'all' || card.dataset.platform === filter;
      card.hidden = !match || total++ >= limit;
    }
    if (more) more.hidden = total <= limit;
  }

  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter;
      limit = PAGE;
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      render();
    }),
  );
  more?.addEventListener('click', () => {
    limit += PAGE;
    render();
  });
  render();
})();
