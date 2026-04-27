(function () {
  const $ = (id) => document.getElementById(id);
  const tradeIdHint = (window.LUMOS_TRADE && window.LUMOS_TRADE.tradeId) || '';
  const listingIdHint = (window.LUMOS_TRADE && window.LUMOS_TRADE.listingId) || '';

  let trade = null;
  // role is derived (not stored): 'seller' | 'buyer' | 'guest' | 'outsider'
  //   seller   = connected wallet == trade.seller_wallet
  //   buyer    = connected wallet == trade.buyer_wallet
  //   guest    = trade is still open and no wallet matches yet (anyone can join)
  //   outsider = trade has a buyer already and the connected wallet is neither
  // localStorage is only used as a hint when the wallet isn't connected yet
  let account = null;
  let chainOk = false;
  let balances = { usdc: 0, pol: 0 };
  let ws = null;
  let countdownInterval = null;

  const escrowAddr = window.LUMOS.escrowAddress;
  const PROVIDER_BLOCK_EXPLORER = 'https://polygonscan.com/tx/';

  // ---------- Initial load ----------
  async function bootstrap() {
    try {
      // If we landed on /listing/{id}, resolve to its trade.
      let tradeId = tradeIdHint;
      if (!tradeId && listingIdHint) {
        const t = await LUMOS.api('GET', `/listings/${listingIdHint}/trade`);
        tradeId = t.id;
        // Reflect this in the URL so links/share work cleanly.
        window.history.replaceState({}, '', `/trade/${tradeId}`);
      }
      if (!tradeId) throw new Error('No trade specified.');

      trade = await LUMOS.api('GET', `/trades/${tradeId}`);

      $('trade-loading').classList.add('hidden');
      $('trade-root').classList.remove('hidden');

      await refreshWalletState();
      render();
      connectWS(trade.id);

      if (window.ethereum) {
        window.ethereum.on?.('accountsChanged', async () => { await refreshWalletState(); render(); });
        window.ethereum.on?.('chainChanged', async () => { await refreshWalletState(); render(); });
      }
    } catch (e) {
      $('trade-loading').innerHTML = `<div class="card-body"><div class="alert alert-danger">${e.message || 'Failed to load trade.'}</div></div>`;
    }
  }

  async function refreshWalletState() {
    if (!LUMOS.hasMetaMask()) {
      account = null; chainOk = false; balances = { usdc: 0, pol: 0 };
      return;
    }
    try {
      account = await LUMOS.getCurrentAccount();
      const cid = await LUMOS.getChainId();
      chainOk = cid === LUMOS.POLYGON_CHAIN_ID;
      if (account && chainOk) {
        balances = await LUMOS.getBalances(account);
      } else {
        balances = { usdc: 0, pol: 0 };
      }
    } catch (e) {
      console.warn(e);
    }
  }

  // ---------- Role resolution ----------
  function computedRole() {
    const hint = localStorage.getItem(`role_${trade.id}`);
    if (account) {
      const lc = account.toLowerCase();
      if (trade.seller_wallet && trade.seller_wallet.toLowerCase() === lc) return 'seller';
      if (trade.buyer_wallet && trade.buyer_wallet.toLowerCase() === lc) return 'buyer';
      // Wallet connected but doesn't match either party
      if (trade.status === 'open' && !trade.buyer_wallet) return 'guest';
      return 'outsider';
    }
    // No wallet connected yet — fall back to hint (UI shows Connect step)
    if (hint === 'seller') return 'seller';
    if (hint === 'buyer' && trade.buyer_wallet) return 'buyer';
    if (trade.status === 'open' && !trade.buyer_wallet) return 'guest';
    return 'outsider';
  }

  // ---------- Render ----------
  function render() {
    renderHeader();
    renderOnboarding();
    renderActions();
  }

  function renderHeader() {
    $('t-id').textContent = trade.id;
    $('t-amount').textContent = LUMOS.fmtUSDC(trade.amount);
    $('t-fee').textContent = LUMOS.fmtUSDC(trade.fee);
    $('t-deposit').textContent = LUMOS.fmtUSDC(trade.total_deposit);
    const price = trade.amount > 0 ? Math.round(trade.total_krw / trade.amount) : 0;
    $('t-price').textContent = LUMOS.fmtKRW(price);
    $('t-total').textContent = LUMOS.fmtKRW(trade.total_krw);
    $('t-seller-short').textContent = LUMOS.short(trade.seller_wallet);

    const statusLabels = {
      open: ['Open', 'badge-success'],
      joined: ['Joined', 'badge-info'],
      locked: ['Locked', 'badge-info'],
      paid: ['Paid', 'badge-warn'],
      released: ['Released', 'badge-success'],
      refunded: ['Refunded', 'badge-muted'],
      expired: ['Expired', 'badge-danger'],
    };
    const [label, cls] = statusLabels[trade.status] || [trade.status, 'badge-muted'];
    const sb = $('t-status');
    sb.textContent = label;
    sb.className = `badge ${cls}`;

    const role = computedRole();

    // Buyer wallet — only visible to seller and the buyer themselves (never to outsiders)
    if (trade.buyer_wallet && (role === 'seller' || role === 'buyer')) {
      $('row-buyer').classList.remove('hidden');
      $('t-buyer').textContent = trade.buyer_wallet;
    } else {
      $('row-buyer').classList.add('hidden');
    }

    // Bank info — only the actual buyer (wallet match) sees this, and only after funds locked
    const showBank = role === 'buyer' && ['locked', 'paid'].includes(trade.status);
    if (showBank && trade.bank_name) {
      $('row-bank').classList.remove('hidden');
      const holder = trade.bank_holder ? ` (${trade.bank_holder})` : '';
      $('t-bank').textContent = `${trade.bank_name} ${trade.bank_account}${holder}`;
    } else {
      $('row-bank').classList.add('hidden');
    }

    // Tx links
    if (trade.deposit_tx_hash) {
      $('row-deposit-tx').classList.remove('hidden');
      const a = $('t-deposit-tx');
      a.href = PROVIDER_BLOCK_EXPLORER + trade.deposit_tx_hash;
      a.textContent = trade.deposit_tx_hash.slice(0, 12) + '…';
    }
    if (trade.release_tx_hash) {
      $('row-release-tx').classList.remove('hidden');
      const a = $('t-release-tx');
      a.href = PROVIDER_BLOCK_EXPLORER + trade.release_tx_hash;
      a.textContent = trade.release_tx_hash.slice(0, 12) + '…';
    }

    // Countdown
    if (trade.expires_at) {
      $('row-expires').classList.remove('hidden');
      startCountdown(trade.expires_at);
    } else {
      $('row-expires').classList.add('hidden');
      clearInterval(countdownInterval);
    }

    // Steps
    const steps = ['open', 'joined', 'locked', 'paid', 'released'];
    const idx = steps.indexOf(trade.status);
    document.querySelectorAll('.steps .step').forEach((el) => {
      el.classList.remove('done', 'active');
      const i = steps.indexOf(el.dataset.step);
      if (i < idx) el.classList.add('done');
      else if (i === idx && idx >= 0) el.classList.add('active');
    });

    // Message
    if (trade.message) {
      $('row-message').classList.remove('hidden');
      $('t-message').textContent = trade.message;
    }
  }

  // ---------- Onboarding gate ----------
  // Determines what (if anything) needs to be resolved before the user can do
  // their next action. Mirrors the PDF spec section 6.
  function neededFor(state, role) {
    // What balance is needed for the upcoming action?
    if (role === 'seller' && state === 'joined') {
      return { usdc: trade.total_deposit, pol: 0.5 };
    }
    if (role === 'buyer' && state === 'locked') {
      return { usdc: 0, pol: 0.5 }; // confirmFiat tx
    }
    if (role === 'seller' && state === 'paid') {
      return { usdc: 0, pol: 0.5 }; // release tx
    }
    if (role === 'guest' && state === 'open') {
      return { usdc: 0, pol: 0.5 }; // join tx (cheap but still gas)
    }
    return { usdc: 0, pol: 0 };
  }

  function renderOnboarding() {
    const root = $('onboarding');
    root.innerHTML = '';
    const role = computedRole();

    // Outsiders never see onboarding — they get a view-only message in renderActions.
    if (role === 'outsider') return;

    // 1. MetaMask not installed
    if (!LUMOS.hasMetaMask()) {
      if (LUMOS.isMobile()) {
        const dl = LUMOS.metaMaskDeepLink();
        root.innerHTML = onboardingCard({
          title: 'Open in MetaMask',
          body: 'On mobile, the trade page must be opened inside the MetaMask in-app browser.',
          actions: [
            { label: 'Open in MetaMask', href: dl, primary: true, target: '_self' },
            { label: 'Install MetaMask', href: 'https://metamask.io/download', primary: false, target: '_blank' },
          ],
        });
      } else {
        root.innerHTML = onboardingCard({
          title: 'Install MetaMask',
          body: 'Lumos uses MetaMask to sign on-chain transactions.',
          actions: [
            { label: 'Install MetaMask', href: 'https://metamask.io/download', primary: true, target: '_blank' },
          ],
        });
      }
      return;
    }

    // 2. Wallet not connected
    if (!account) {
      root.innerHTML = onboardingCard({
        title: 'Connect your wallet',
        body: 'Connect MetaMask to continue.',
        actions: [{ label: 'Connect Wallet', primary: true, onclick: 'LumosTrade.connect()' }],
      });
      return;
    }

    // 3. Wrong network
    if (!chainOk) {
      root.innerHTML = onboardingCard({
        title: 'Switch to Polygon',
        body: 'Lumos only supports USDC on Polygon. Switch your network and return here.',
        actions: [{ label: 'Switch to Polygon', primary: true, onclick: 'LumosTrade.switchNetwork()' }],
      });
      return;
    }

    // Role-specific balance gates depend on what action is next.
    const need = neededFor(trade.status, role);

    // 4. USDC shortfall (seller, before deposit)
    if (need.usdc > 0 && balances.usdc < need.usdc) {
      root.innerHTML = onboardingCard({
        title: 'Top up USDC on Polygon',
        body: `You need ${LUMOS.fmtUSDC(need.usdc)} USDC for this trade. Current: ${LUMOS.fmtUSDC(balances.usdc)} USDC.`,
        actions: buyActions('USDC', need.usdc, account),
        footer: LUMOS.isInMetaMaskApp()
          ? 'In-app: tap your account → Buy. Pick USDC on Polygon.'
          : 'You also need a small amount of POL for gas fees.',
      });
      return;
    }

    // 5. POL shortfall
    if (need.pol > 0 && balances.pol < 0.05) {
      root.innerHTML = onboardingCard({
        title: 'Get POL for gas',
        body: `POL is required to pay Polygon network fees. Current: ${balances.pol.toFixed(4)} POL.`,
        actions: buyActions('POL', 5, account),
        footer: LUMOS.isInMetaMaskApp()
          ? 'In-app: tap your account → Buy. Pick POL on Polygon.'
          : 'USDC is used for the trade, but POL is required for network fees.',
      });
      return;
    }

    // All conditions met — no onboarding card needed.
  }

  // Build environment-aware "buy" CTAs.
  // - In MetaMask mobile in-app browser: surface MetaMask's own buy deeplink (most reliable).
  // - On desktop browser: link to MetaMask Portfolio buy aggregator.
  // - Always include a fallback "Open in MetaMask app" deeplink and a CEX hint.
  function buyActions(token, amount, wallet) {
    const out = [];
    if (LUMOS.isInMetaMaskApp()) {
      // Inside MM mobile — open the in-app onramp directly.
      out.push({ label: `Open MetaMask Buy`, href: 'metamask://buy', primary: true, target: '_self' });
      out.push({ label: `Or open Portfolio`, href: 'https://portfolio.metamask.io/buy', primary: false, target: '_blank' });
    } else if (LUMOS.isMobile()) {
      // Mobile but not in MM app — point at MM mobile via deeplink, plus Portfolio fallback.
      out.push({ label: `Open MetaMask Buy`, href: 'https://metamask.app.link/buy', primary: true, target: '_self' });
      out.push({ label: `Buy in browser`, href: token === 'POL' ? LUMOS.buyPolLink(wallet) : LUMOS.buyUsdcLink(wallet, amount), primary: false, target: '_blank' });
    } else {
      // Desktop: Portfolio is the most direct path.
      const link = token === 'POL' ? LUMOS.buyPolLink(wallet) : LUMOS.buyUsdcLink(wallet, amount);
      out.push({ label: `Buy ${token === 'USDC' ? LUMOS.fmtUSDC(amount) + ' USDC' : 'POL'}`, href: link, primary: true, target: '_blank' });
    }
    return out;
  }

  function onboardingCard({ title, body, actions, footer }) {
    const buttons = actions.map((a) => {
      if (a.href) {
        return `<a class="btn ${a.primary ? 'btn-primary' : 'btn-outline'}" href="${a.href}" target="${a.target || '_blank'}" rel="noopener">${a.label}</a>`;
      }
      return `<button class="btn ${a.primary ? 'btn-primary' : 'btn-outline'}" onclick="${a.onclick}">${a.label}</button>`;
    }).join('');
    return `
      <div class="card">
        <div class="card-body">
          <h3 class="text-lg font-semibold mb-2">${title}</h3>
          <p class="text-sm text-muted mb-4">${body}</p>
          <div class="row gap-2" style="flex-wrap: wrap;">${buttons}</div>
          ${footer ? `<div class="help-text mt-3">${footer}</div>` : ''}
        </div>
      </div>
    `;
  }

  // ---------- State-driven actions ----------
  function renderActions() {
    const root = $('actions');
    root.innerHTML = '';
    const role = computedRole();
    const isSeller = role === 'seller';
    const isBuyer = role === 'buyer';
    const isGuest = role === 'guest';
    const isOutsider = role === 'outsider';

    // Onboarding may have rendered a gate above; if we don't have account/chain
    // yet, the action buttons stay hidden so users can't click into a failure.
    const onboardingResolved = LUMOS.hasMetaMask() && account && chainOk;

    // Outsider — trade already has a buyer and you're not seller or buyer.
    if (isOutsider) {
      root.innerHTML = wrap(`
        <div class="alert alert-info">
          <span>🔒</span>
          <div>
            <strong>This trade is in progress between two other parties.</strong><br>
            <span class="text-sm">You can view the public summary above, but bank details and actions are not available.</span>
          </div>
        </div>
        <a href="/marketplace" class="btn btn-outline btn-block mt-3">Browse other listings</a>
      `);
      return;
    }

    if (trade.status === 'open' && isGuest) {
      root.innerHTML = `
        <div class="card">
          <div class="card-body">
            <h3 class="text-lg font-semibold mb-2">Join this trade</h3>
            <p class="text-sm text-muted mb-4">Connect your Polygon wallet and join. The seller will then deposit USDC into escrow. Once you join, the listing closes for everyone else.</p>
            ${onboardingResolved ? `
              <div class="kv-row mb-2"><span>Your wallet</span><span class="font-mono text-xs break-all">${account}</span></div>
              <button id="btn-join" class="btn btn-primary btn-block btn-lg">Join Trade</button>
            ` : ''}
          </div>
        </div>`;
      const btn = $('btn-join'); if (btn) btn.onclick = onJoin;
      return;
    }
    if (trade.status === 'open' && isSeller) {
      root.innerHTML = wrap(`
        <div class="alert alert-info"><span>⏳</span><div><strong>Waiting for a buyer.</strong> Share <a href="${shareUrl()}" class="tx-link">this listing</a> or wait for someone from the marketplace.</div></div>
        <button class="btn btn-outline btn-sm mt-3" onclick="LumosTrade.copyLink()">Copy listing link</button>
      `);
      return;
    }

    if (trade.status === 'joined' && isSeller) {
      root.innerHTML = wrap(`
        <div class="alert alert-info"><span>👤</span><div>The buyer has joined. Deposit <strong>${LUMOS.fmtUSDC(trade.total_deposit)} USDC</strong> (${LUMOS.fmtUSDC(trade.amount)} amount + ${LUMOS.fmtUSDC(trade.fee)} fee) into escrow.</div></div>
        ${onboardingResolved ? `<button id="btn-deposit" class="btn btn-primary btn-block btn-lg mt-3">Deposit ${LUMOS.fmtUSDC(trade.total_deposit)} USDC</button>` : ''}
      `);
      const btn = $('btn-deposit'); if (btn) btn.onclick = onDeposit;
      return;
    }
    if (trade.status === 'joined' && isBuyer) {
      root.innerHTML = wrap(`<div class="alert alert-info"><span>⏳</span><div>You have joined. Waiting for the seller to deposit USDC into escrow.</div></div>`);
      return;
    }

    if (trade.status === 'locked' && isSeller) {
      root.innerHTML = wrap(`
        <div class="alert alert-success"><span>🔒</span><div>USDC is locked in escrow. Waiting for the buyer's KRW payment.</div></div>
        ${onboardingResolved ? `<button id="btn-refund" class="btn btn-destructive btn-block mt-3">Request Refund</button>
        <div class="help-text mt-1">Refund is blocked once the buyer confirms KRW payment on-chain.</div>` : ''}
      `);
      const btn = $('btn-refund'); if (btn) btn.onclick = onRefund;
      return;
    }
    if (trade.status === 'locked' && isBuyer) {
      const holder = trade.bank_holder ? ` · ${trade.bank_holder}` : '';
      root.innerHTML = wrap(`
        <div class="alert alert-warn">
          <span>💸</span>
          <div>
            <strong>Send ₩${LUMOS.fmtKRW(trade.total_krw)}</strong> to:<br>
            <span class="font-mono text-sm">${trade.bank_name} ${trade.bank_account}${holder}</span>
          </div>
        </div>
        ${onboardingResolved ? `<button id="btn-confirm" class="btn btn-primary btn-block btn-lg mt-3">I have sent payment</button>
        <div class="help-text mt-1">Confirms on-chain. After this the seller cannot refund. If they don't release within 24h, you can self-claim the USDC.</div>` : ''}
      `);
      const btn = $('btn-confirm'); if (btn) btn.onclick = onConfirmFiat;
      return;
    }

    if (trade.status === 'paid' && isSeller) {
      root.innerHTML = wrap(`
        <div class="alert alert-success"><span>✅</span><div>The buyer confirmed payment on-chain. Verify the KRW deposit in your bank app, then release USDC.</div></div>
        ${onboardingResolved ? `<button id="btn-release" class="btn btn-success btn-block btn-lg mt-3">Confirm payment & release USDC</button>` : ''}
      `);
      const btn = $('btn-release'); if (btn) btn.onclick = onRelease;
      return;
    }
    if (trade.status === 'paid' && isBuyer) {
      root.innerHTML = wrap(`
        <div class="alert alert-info"><span>⏳</span><div>Payment confirmed. Waiting for the seller to release USDC. After 24h you can self-claim.</div></div>
        ${onboardingResolved ? `<button id="btn-claim" class="btn btn-outline btn-block mt-3">Claim USDC (after 24h)</button>` : ''}
      `);
      const btn = $('btn-claim'); if (btn) btn.onclick = onClaim;
      return;
    }

    if (trade.status === 'released') {
      root.innerHTML = wrap(`<div class="alert alert-success"><span>🎉</span><div><strong>Trade complete.</strong> Buyer received ${LUMOS.fmtUSDC(trade.amount)} USDC; platform fee of ${LUMOS.fmtUSDC(trade.fee)} USDC was paid.</div></div>`);
      return;
    }
    if (trade.status === 'refunded') {
      root.innerHTML = wrap(`<div class="alert alert-info"><span>↩️</span><div>USDC was refunded to the seller.</div></div>`);
      return;
    }
    if (trade.status === 'expired') {
      root.innerHTML = wrap(`<div class="alert alert-danger"><span>⌛</span><div>This trade expired before completion.</div></div>`);
      return;
    }
  }

  function wrap(inner) {
    return `<div class="card"><div class="card-body">${inner}</div></div>`;
  }
  function shareUrl() {
    return `${window.location.origin}/listing/${trade.listing_id || ''}`;
  }

  // ---------- On-chain actions ----------
  async function withSigner() {
    if (!escrowAddr) throw new Error('Escrow contract address is not configured.');
    await LUMOS.connect();
    await LUMOS.switchToPolygon();
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    return { signer, provider };
  }

  async function onJoin() {
    try {
      const acc = await LUMOS.connect();
      await LUMOS.switchToPolygon();
      // Reject early if the connecting wallet is the seller's wallet.
      if (trade.seller_wallet && acc.toLowerCase() === trade.seller_wallet.toLowerCase()) {
        throw new Error('You cannot buy from yourself. Switch to a different wallet to join.');
      }
      const updated = await LUMOS.api('POST', `/trades/${trade.id}/join`, { buyer_wallet: acc });
      localStorage.setItem(`role_${trade.id}`, 'buyer');
      trade = updated;
      await refreshWalletState();
      render();
    } catch (e) {
      alert(e.message);
    }
  }

  async function onDeposit() {
    const btn = $('btn-deposit');
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Approving USDC…';
      const { signer } = await withSigner();
      const usdc = new ethers.Contract(LUMOS.USDC_ADDRESS, LUMOS.ERC20_ABI, signer);
      const totalRaw = ethers.parseUnits(String(trade.total_deposit), LUMOS.USDC_DECIMALS);
      const me = await signer.getAddress();
      const allowance = await usdc.allowance(me, escrowAddr);
      if (allowance < totalRaw) {
        const tx = await usdc.approve(escrowAddr, totalRaw);
        btn.innerHTML = '<span class="spinner"></span> Confirming approval…';
        await tx.wait();
      }
      btn.innerHTML = '<span class="spinner"></span> Depositing into escrow…';
      const escrow = new ethers.Contract(escrowAddr, LUMOS.ESCROW_ABI, signer);
      const idBytes = LUMOS.uuidToBytes32(trade.id);
      const amountRaw = ethers.parseUnits(String(trade.amount), LUMOS.USDC_DECIMALS);
      const feeRaw = ethers.parseUnits(String(trade.fee), LUMOS.USDC_DECIMALS);
      const tx = await escrow.deposit(idBytes, trade.buyer_wallet, amountRaw, feeRaw);
      btn.innerHTML = '<span class="spinner"></span> Confirming on-chain…';
      await tx.wait();
      pollUntilStatus('locked');
    } catch (e) {
      alert((e && (e.reason || e.shortMessage || e.message)) || 'Deposit failed.');
      btn.disabled = false; btn.textContent = `Deposit ${LUMOS.fmtUSDC(trade.total_deposit)} USDC`;
    }
  }

  async function onConfirmFiat() {
    if (!confirm('Have you sent the KRW payment? Once confirmed on-chain, the seller cannot refund.')) return;
    const btn = $('btn-confirm');
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Confirming on-chain…';
      const { signer } = await withSigner();
      const escrow = new ethers.Contract(escrowAddr, LUMOS.ESCROW_ABI, signer);
      const tx = await escrow.confirmFiat(LUMOS.uuidToBytes32(trade.id));
      await tx.wait();
      pollUntilStatus('paid');
    } catch (e) {
      alert((e && (e.reason || e.shortMessage || e.message)) || 'Confirmation failed.');
      btn.disabled = false; btn.textContent = 'I have sent payment';
    }
  }

  async function onRelease() {
    if (!confirm('Verify the KRW arrived in your bank account, then release USDC to the buyer.')) return;
    const btn = $('btn-release');
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Releasing…';
      const { signer } = await withSigner();
      const escrow = new ethers.Contract(escrowAddr, LUMOS.ESCROW_ABI, signer);
      const tx = await escrow.release(LUMOS.uuidToBytes32(trade.id));
      await tx.wait();
      pollUntilStatus('released');
    } catch (e) {
      alert((e && (e.reason || e.shortMessage || e.message)) || 'Release failed.');
      btn.disabled = false; btn.textContent = 'Confirm payment & release USDC';
    }
  }

  async function onRefund() {
    if (!confirm('Refund the deposit? Only allowed before the buyer confirms KRW payment.')) return;
    const btn = $('btn-refund');
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Refunding…';
      const { signer } = await withSigner();
      const escrow = new ethers.Contract(escrowAddr, LUMOS.ESCROW_ABI, signer);
      const tx = await escrow.refund(LUMOS.uuidToBytes32(trade.id));
      await tx.wait();
      pollUntilStatus('refunded');
    } catch (e) {
      alert((e && (e.reason || e.shortMessage || e.message)) || 'Refund failed.');
      btn.disabled = false; btn.textContent = 'Request Refund';
    }
  }

  async function onClaim() {
    if (!confirm('Claim USDC. This works only if the seller has not released within 24h of your payment confirmation.')) return;
    const btn = $('btn-claim');
    try {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Claiming…';
      const { signer } = await withSigner();
      const escrow = new ethers.Contract(escrowAddr, LUMOS.ESCROW_ABI, signer);
      const tx = await escrow.claimByBuyer(LUMOS.uuidToBytes32(trade.id));
      await tx.wait();
      pollUntilStatus('released');
    } catch (e) {
      alert((e && (e.reason || e.shortMessage || e.message)) || 'Claim failed.');
      btn.disabled = false; btn.textContent = 'Claim USDC (after 24h)';
    }
  }

  // ---------- Polling helper ----------
  function pollUntilStatus(target) {
    const fromStatus = trade.status;
    let attempts = 0;
    const max = 60;
    const tick = setInterval(async () => {
      attempts++;
      try {
        const fresh = await LUMOS.api('GET', `/trades/${trade.id}`);
        if (fresh.status !== fromStatus) {
          clearInterval(tick);
          trade = fresh;
          await refreshWalletState();
          render();
          return;
        }
      } catch {}
      if (attempts >= max) {
        clearInterval(tick);
        window.location.reload();
      }
    }, 1000);
  }

  // ---------- WebSocket ----------
  function connectWS(tradeId) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (ws) ws.close();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/${tradeId}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'trade_update') {
        trade = msg.trade;
        render();
      }
    };
    ws.onclose = () => { ws = null; setTimeout(() => connectWS(tradeId), 3000); };
  }

  // ---------- Countdown ----------
  function startCountdown(iso) {
    clearInterval(countdownInterval);
    const update = () => {
      const diff = new Date(iso) - new Date();
      if (diff <= 0) {
        $('t-expires').textContent = 'Expired';
        clearInterval(countdownInterval);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      $('t-expires').textContent = `${m}m ${s}s`;
    };
    update();
    countdownInterval = setInterval(update, 1000);
  }

  // ---------- Public API ----------
  window.LumosTrade = {
    connect: async () => { try { await LUMOS.connect(); await refreshWalletState(); render(); } catch (e) { alert(e.message); } },
    switchNetwork: async () => { try { await LUMOS.switchToPolygon(); await refreshWalletState(); render(); } catch (e) { alert(e.message); } },
    copyLink: async () => {
      try {
        await navigator.clipboard.writeText(shareUrl());
        alert('Listing link copied.');
      } catch { alert(shareUrl()); }
    },
  };

  bootstrap();
})();
