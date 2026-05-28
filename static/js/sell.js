(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('sell-form');
  const submitBtn = $('submit-btn');
  const calcCard = $('calc-card');

  const feeBps = (window.LUMOS.feeBps != null ? window.LUMOS.feeBps : 50);
  $('calc-fee-pct').textContent = (feeBps / 100).toString();

  // ---------- Wallet state ----------
  let account = null;
  let chainOk = false;

  function setWalletViewState() {
    const disconnected = $('wallet-disconnected');
    const wrong = $('wallet-wrong-network');
    const ok = $('wallet-connected');
    disconnected.classList.add('hidden');
    wrong.classList.add('hidden');
    ok.classList.add('hidden');

    if (!account) {
      disconnected.classList.remove('hidden');
      // Mobile install/deep-link hint
      const hint = $('install-hint');
      if (!LUMOS.hasMetaMask()) {
        if (LUMOS.isMobile()) {
          hint.innerHTML = `On mobile, open this page in the <a href="${LUMOS.metaMaskDeepLink()}">MetaMask app</a>.`;
        } else {
          hint.innerHTML = `Don't have MetaMask? <a href="https://metamask.io/download" target="_blank" rel="noopener">Install it</a>.`;
        }
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connect wallet to publish';
      return;
    }
    if (!chainOk) {
      $('wallet-addr-short').textContent = LUMOS.short(account);
      wrong.classList.remove('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Switch network to publish';
      return;
    }
    $('wallet-addr').textContent = LUMOS.short(account);
    ok.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publish sell order';
  }

  async function refreshWallet() {
    if (!LUMOS.hasMetaMask()) {
      account = null; chainOk = false;
      setWalletViewState();
      return;
    }
    try {
      account = await LUMOS.getCurrentAccount();
      const cid = await LUMOS.getChainId();
      chainOk = cid === LUMOS.POLYGON_CHAIN_ID;
    } catch (e) {
      console.warn(e);
    }
    setWalletViewState();
  }

  async function onConnect() {
    try {
      if (!LUMOS.hasMetaMask()) {
        if (LUMOS.isMobile()) {
          window.location.href = LUMOS.metaMaskDeepLink();
          return;
        }
        window.open('https://metamask.io/download', '_blank', 'noopener');
        return;
      }
      account = await LUMOS.connect();
      // Auto-switch to Polygon right after connecting (PDF 2번).
      try {
        await LUMOS.switchToPolygon();
      } catch (e) {
        console.warn('Polygon switch declined or failed', e);
      }
      await refreshWallet();
    } catch (e) {
      alert(e.message || 'Failed to connect wallet.');
    }
  }

  async function onSwitch() {
    try {
      await LUMOS.switchToPolygon();
      await refreshWallet();
    } catch (e) {
      alert(e.message || 'Failed to switch network.');
    }
  }

  $('btn-connect').addEventListener('click', onConnect);
  $('btn-switch').addEventListener('click', onSwitch);
  $('btn-change').addEventListener('click', onConnect);

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', refreshWallet);
    window.ethereum.on?.('chainChanged', refreshWallet);
  }

  // ---------- KRW-first calculation ----------
  // The seller enters KRW they want to receive; USDC amount is derived from price.
  // Backend still receives (amount, price_per_usdc_krw) — we compute amount here.
  function currentAmount() {
    const krw = Number($('krw-receive').value) || 0;
    const price = Number($('price').value) || 0;
    if (krw <= 0 || price <= 0) return 0;
    return +(krw / price).toFixed(6);
  }

  function recalc() {
    const amount = currentAmount();
    const price = Number($('price').value) || 0;
    if (amount <= 0 || price <= 0) {
      calcCard.classList.add('hidden');
      return;
    }
    const fee = +(amount * (feeBps / 10000)).toFixed(6);
    const deposit = +(amount + fee).toFixed(6);
    const krw = Math.round(amount * price);
    $('calc-amount').textContent = LUMOS.fmtUSDC(amount);
    $('calc-fee').textContent = LUMOS.fmtUSDC(fee);
    $('calc-deposit').textContent = `${LUMOS.fmtUSDC(deposit)} USDC`;
    $('calc-krw').textContent = `₩${LUMOS.fmtKRW(krw)}`;
    calcCard.classList.remove('hidden');
  }

  $('krw-receive').addEventListener('input', recalc);
  $('price').addEventListener('input', () => {
    // Once the seller types their own rate, stop auto-filling from the market.
    $('price').dataset.userEdited = '1';
    recalc();
  });

  // ---------- Live market rate ----------
  // Pre-fill the price with the live USDC→KRW market rate so the seller sees a
  // sensible default. They can still override it (sets data-user-edited).
  async function loadRate() {
    try {
      const r = await LUMOS.api('GET', '/rate');
      if (!r || !(r.usdc_krw > 0)) return;
      const krw = Math.round(r.usdc_krw);
      const hint = $('price-hint');
      if (hint) {
        hint.textContent = r.source === 'fallback'
          ? '(set your rate; live market unavailable)'
          : `(set your rate; live market ~₩${LUMOS.fmtKRW(krw)})`;
      }
      const priceEl = $('price');
      if (!priceEl.dataset.userEdited) {
        priceEl.value = krw;
        recalc();
      }
    } catch (e) {
      console.warn('rate load failed', e);
    }
  }

  document.querySelectorAll('.krw-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('krw-receive').value = btn.dataset.amt;
      recalc();
    });
  });

  // ---------- Submit ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!account || !chainOk) {
      alert('Connect your wallet and switch to Polygon first.');
      return;
    }
    const amount = currentAmount();
    const price = Number($('price').value);
    if (!(amount > 0) || !(price > 0)) {
      alert('Enter a valid KRW amount and price.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Publishing…';

    try {
      const body = {
        seller_wallet: account,
        amount,
        price_per_usdc_krw: price,
        bank_name: $('bank-name').value,
        bank_account: $('bank-account').value.trim(),
        bank_holder: $('bank-holder').value.trim() || null,
        nickname: $('nickname').value.trim() || null,
        message: $('message').value.trim() || null,
      };
      const listing = await LUMOS.api('POST', '/listings', body);
      localStorage.setItem(`role_${listing.trade_id}`, 'seller');
      window.location.href = `/trade/${listing.trade_id}`;
    } catch (err) {
      alert(err.message || 'Failed to publish.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish sell order';
    }
  });

  // Initial paint
  refreshWallet();
  loadRate();
})();
