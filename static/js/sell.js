(function () {
  const form = document.getElementById('sell-form');
  const submitBtn = document.getElementById('submit-btn');
  const calcCard = document.getElementById('calc-card');

  const $ = (id) => document.getElementById(id);
  const feeBps = (window.LUMOS.feeBps != null ? window.LUMOS.feeBps : 50);
  $('calc-fee-pct').textContent = (feeBps / 100).toString();

  function recalc() {
    const amount = Number($('amount').value) || 0;
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
  $('amount').addEventListener('input', recalc);
  $('price').addEventListener('input', recalc);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Publishing…';

    try {
      const body = {
        seller_wallet: $('seller-wallet').value.trim(),
        amount: Number($('amount').value),
        price_per_usdc_krw: Number($('price').value),
        bank_name: $('bank-name').value,
        bank_account: $('bank-account').value.trim(),
        bank_holder: $('bank-holder').value.trim() || null,
        nickname: $('nickname').value.trim() || null,
        message: $('message').value.trim() || null,
      };
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.seller_wallet)) {
        throw new Error('Seller wallet must be a 0x… 40-hex address.');
      }
      const listing = await LUMOS.api('POST', '/listings', body);
      // Save role so trade page knows we're the seller
      localStorage.setItem(`role_${listing.trade_id}`, 'seller');
      window.location.href = `/trade/${listing.trade_id}`;
    } catch (err) {
      alert(err.message || 'Failed to publish.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish sell order';
    }
  });
})();
