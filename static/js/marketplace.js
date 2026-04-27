(function () {
  const grid = document.getElementById('listing-grid');
  const empty = document.getElementById('empty');

  const filters = {
    minA: document.getElementById('f-min-amount'),
    maxA: document.getElementById('f-max-amount'),
    minP: document.getElementById('f-min-price'),
    maxP: document.getElementById('f-max-price'),
    sort: document.getElementById('f-sort'),
  };

  function timeAgo(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function statusBadge(status) {
    const map = {
      open:    ['badge-success', 'Available'],
      joined:  ['badge-info', 'In progress'],
      locked:  ['badge-info', 'In progress'],
      paid:    ['badge-info', 'In progress'],
      released:['badge-muted', 'Closed'],
      refunded:['badge-muted', 'Refunded'],
      expired: ['badge-muted', 'Expired'],
    };
    const [cls, label] = map[status] || ['badge-muted', status];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function listingCard(l) {
    const initial = (l.nickname || 'A').slice(0, 1).toUpperCase();
    return `
      <a class="card card-hover listing-card" href="/listing/${l.id}">
        <div class="card-body">
          <div class="row-between mb-4">
            <div class="row gap-2">
              <div class="avatar">${initial}</div>
              <div class="text-sm font-semibold">${(l.nickname || 'Anonymous').replace(/</g,'&lt;')}</div>
            </div>
            ${statusBadge(l.status)}
          </div>
          <div class="kv-row"><span>Buyer receives</span><span class="amount-display">${LUMOS.fmtUSDC(l.amount)} USDC</span></div>
          <div class="kv-row"><span>Price</span><span class="text-sm">₩${LUMOS.fmtKRW(l.price_per_usdc_krw)} / USDC</span></div>
          <div class="kv-row"><span>Total</span><span class="total-amount">₩${LUMOS.fmtKRW(l.total_krw)}</span></div>
          <div class="text-xs text-muted mt-3">⏱ ${timeAgo(l.created_at)}</div>
        </div>
      </a>
    `;
  }

  async function load() {
    grid.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    empty.classList.add('hidden');

    const params = new URLSearchParams();
    if (filters.minA.value) params.set('min_amount', filters.minA.value);
    if (filters.maxA.value) params.set('max_amount', filters.maxA.value);
    if (filters.minP.value) params.set('min_price', filters.minP.value);
    if (filters.maxP.value) params.set('max_price', filters.maxP.value);
    params.set('sort', filters.sort.value);
    params.set('status', 'open');

    try {
      const data = await LUMOS.api('GET', `/listings?${params.toString()}`);
      if (!data.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      grid.innerHTML = data.map(listingCard).join('');
    } catch (e) {
      grid.innerHTML = `<div class="alert alert-danger">Failed to load: ${e.message}</div>`;
    }
  }

  let timer;
  function debouncedLoad() {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  }
  Object.values(filters).forEach((el) => el.addEventListener('input', debouncedLoad));
  filters.sort.addEventListener('change', load);

  load();
})();
