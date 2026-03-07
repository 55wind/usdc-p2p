let currentTrade = null;
let currentRole = null; // 'seller' or 'buyer'
let ws = null;
let countdownInterval = null;

// Contract addresses
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLYGON_CHAIN_ID = '0x89'; // 137

// Escrow contract address
let ESCROW_ADDRESS = '0xC4aa00e5DFe7F88D6EE26917463e3CaeA29955e6';

// Minimal ABIs for MetaMask interactions
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

const ESCROW_ABI = [
    'function deposit(bytes32 tradeId, address buyer, uint256 amount)',
    'function confirmFiat(bytes32 tradeId)',
    'function release(bytes32 tradeId)',
    'function refund(bytes32 tradeId)',
    'function claimByBuyer(bytes32 tradeId)',
    'event Deposited(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount)',
    'event FiatConfirmed(bytes32 indexed tradeId, address indexed buyer)',
    'event Released(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount)',
    'event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount)',
    'event BuyerClaimed(bytes32 indexed tradeId, address indexed buyer, uint256 amount)'
];

const USDC_DECIMALS = 6;

// ---- MetaMask helpers ----

async function connectMetaMask() {
    if (!window.ethereum) {
        throw new Error('MetaMask is not installed.');
    }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    await switchToPolygon();
    return accounts[0];
}

async function switchToPolygon() {
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: POLYGON_CHAIN_ID }],
        });
    } catch (err) {
        if (err.code === 4902) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: POLYGON_CHAIN_ID,
                    chainName: 'Polygon Mainnet',
                    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
                    rpcUrls: ['https://polygon-rpc.com'],
                    blockExplorerUrls: ['https://polygonscan.com/'],
                }],
            });
        } else {
            throw err;
        }
    }
}

function uuidToBytes32(uuid) {
    const hex = uuid.replace(/-/g, '');
    return '0x' + hex.padEnd(64, '0');
}

// ---- Escrow address loader ----
async function loadEscrowAddress() {
    try {
        const resp = await fetch('/api/trades/config');
        if (resp.ok) {
            const data = await resp.json();
            if (data.escrow_contract_address) {
                ESCROW_ADDRESS = data.escrow_contract_address;
            }
        }
    } catch (e) { /* ignore */ }
}

// ---- Routing ----

function navigateTo(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${screen}`).classList.add('active');
}

// Check URL for trade ID on load
window.addEventListener('load', async () => {
    await loadEscrowAddress();

    const path = window.location.pathname;
    const match = path.match(/^\/trade\/([a-f0-9-]+)$/);
    if (match) {
        const tradeId = match[1];
        const savedRole = localStorage.getItem(`role_${tradeId}`);
        if (savedRole) {
            currentRole = savedRole;
        }
        loadTrade(tradeId);
    }
});

// ---- API helpers ----

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Request failed');
    }
    return res.json();
}

// ---- Create trade (seller) ----

async function createTrade(e) {
    e.preventDefault();
    try {
        const trade = await api('POST', '/trades', {
            seller_wallet: document.getElementById('seller-wallet').value,
            usdc_amount: parseFloat(document.getElementById('usdc-amount').value),
            total_krw: parseFloat(document.getElementById('total-krw').value),
            bank_name: document.getElementById('bank-name').value,
            bank_account: document.getElementById('bank-account').value,
        });
        currentTrade = trade;
        currentRole = 'seller';
        localStorage.setItem(`role_${trade.id}`, 'seller');

        const url = `${window.location.origin}/trade/${trade.id}`;
        document.getElementById('share-url').value = url;
        navigateTo('share');

        window.history.pushState({}, '', `/trade/${trade.id}`);
        connectWebSocket(trade.id);
    } catch (err) {
        alert(err.message);
    }
}

function copyLink() {
    const input = document.getElementById('share-url');
    input.select();
    navigator.clipboard.writeText(input.value);
}

function goToTrade() {
    if (currentTrade) {
        showTradeScreen(currentTrade);
    }
}

// ---- Load trade by ID ----

async function loadTrade(tradeId) {
    try {
        const trade = await api('GET', `/trades/${tradeId}`);
        currentTrade = trade;

        if (!currentRole) {
            currentRole = 'buyer';
            localStorage.setItem(`role_${tradeId}`, 'buyer');
        }

        if (trade.status === 'created' && currentRole === 'buyer') {
            showJoinScreen(trade);
        } else {
            showTradeScreen(trade);
        }
    } catch {
        alert('Trade not found.');
        navigateTo('home');
    }
}

// ---- Join screen (buyer) ----

function showJoinScreen(trade) {
    const info = document.getElementById('join-info');
    info.innerHTML = `
        <div class="info-row"><span>USDC Amount</span><span>${trade.usdc_amount} USDC</span></div>
        <div class="info-row"><span>Total Price</span><span>${Number(trade.total_krw).toLocaleString()} KRW</span></div>
        <div class="info-row"><span>Seller Wallet</span><span class="mono">${trade.seller_wallet}</span></div>
    `;
    navigateTo('join');
}

async function joinTrade(e) {
    e.preventDefault();
    try {
        const trade = await api('POST', `/trades/${currentTrade.id}/join`, {
            buyer_wallet: document.getElementById('buyer-wallet').value,
        });
        currentTrade = trade;
        currentRole = 'buyer';
        localStorage.setItem(`role_${trade.id}`, 'buyer');
        window.history.pushState({}, '', `/trade/${trade.id}`);
        showTradeScreen(trade);
    } catch (err) {
        alert(err.message);
    }
}

// ---- Trade status screen ----

function showTradeScreen(trade) {
    currentTrade = trade;
    navigateTo('trade');
    updateTradeUI(trade);
    connectWebSocket(trade.id);
}

function updateTradeUI(trade) {
    document.getElementById('t-id').textContent = trade.id.slice(0, 8) + '...';
    document.getElementById('t-amount').textContent = trade.usdc_amount + ' USDC';
    document.getElementById('t-total').textContent = Number(trade.total_krw).toLocaleString() + ' KRW';
    document.getElementById('t-seller').textContent = trade.seller_wallet;
    document.getElementById('t-buyer').textContent = trade.buyer_wallet || '-';

    // Badge
    const badge = document.getElementById('trade-status-badge');
    badge.textContent = statusLabel(trade.status);
    badge.className = `badge badge-${trade.status}`;

    // Escrow TX hash
    const escrowTxRow = document.getElementById('row-escrow-tx');
    if (trade.escrow_tx_hash) {
        escrowTxRow.style.display = 'flex';
        document.getElementById('t-escrow-tx').innerHTML =
            `<a href="https://polygonscan.com/tx/${trade.escrow_tx_hash}" target="_blank" style="color:var(--accent)">${trade.escrow_tx_hash.slice(0, 16)}...</a>`;
    } else {
        escrowTxRow.style.display = 'none';
    }

    // Release TX hash
    const releaseTxRow = document.getElementById('row-release-tx');
    if (trade.release_tx_hash) {
        releaseTxRow.style.display = 'flex';
        document.getElementById('t-release-tx').innerHTML =
            `<a href="https://polygonscan.com/tx/${trade.release_tx_hash}" target="_blank" style="color:var(--accent)">${trade.release_tx_hash.slice(0, 16)}...</a>`;
    } else {
        releaseTxRow.style.display = 'none';
    }

    // Bank account - show to buyer when status is usdc_escrowed or fiat_sent
    const bankRow = document.getElementById('row-bank');
    if (trade.bank_name && currentRole === 'buyer' && ['usdc_escrowed', 'fiat_sent'].includes(trade.status)) {
        bankRow.style.display = 'flex';
        document.getElementById('t-bank').textContent = `${trade.bank_name} ${trade.bank_account}`;
    } else {
        bankRow.style.display = 'none';
    }

    // Countdown
    const expiresRow = document.getElementById('row-expires');
    if (trade.expires_at) {
        expiresRow.style.display = 'flex';
        startCountdown(trade.expires_at);
    } else {
        expiresRow.style.display = 'none';
        clearInterval(countdownInterval);
    }

    // Progress steps
    const steps = ['created', 'joined', 'usdc_escrowed', 'fiat_sent', 'completed'];
    const idx = steps.indexOf(trade.status);
    steps.forEach((s, i) => {
        const el = document.getElementById(`step-${s}`);
        if (!el) return;
        el.className = 'step';
        if (i < idx) el.classList.add('done');
        else if (i === idx) el.classList.add('active');
    });

    // Actions (role-aware)
    renderActions(trade);
}

// ---- Reload trade after on-chain tx ----

function reloadTradeAfterTx() {
    // Poll every 2 seconds, reload UI each time so user sees latest state
    let attempts = 0;
    const maxAttempts = 15; // 30 seconds max

    const poll = setInterval(async () => {
        attempts++;
        try {
            const trade = await api('GET', `/trades/${currentTrade.id}`);
            if (trade.status !== currentTrade.status || attempts >= maxAttempts) {
                clearInterval(poll);
                currentTrade = trade;
                updateTradeUI(trade);
            }
        } catch (e) { /* ignore */ }
        if (attempts >= maxAttempts) {
            clearInterval(poll);
            loadTrade(currentTrade.id);
        }
    }, 2000);
}

// ---- Escrow interactions (MetaMask) ----

async function depositToEscrow() {
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
        const amount = ethers.parseUnits(String(currentTrade.usdc_amount), USDC_DECIMALS);
        const escrowAddr = ESCROW_ADDRESS;

        if (!escrowAddr) {
            alert('Escrow contract address is not configured.');
            return;
        }

        // Step 1: Approve
        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Approving USDC... (Confirm in MetaMask)';
        }

        const currentAllowance = await usdcContract.allowance(account, escrowAddr);
        if (currentAllowance < amount) {
            const approveTx = await usdcContract.approve(escrowAddr, amount);
            if (btn) btn.textContent = 'Waiting for Approve transaction...';
            await approveTx.wait();
        }

        // Step 2: Deposit
        if (btn) btn.textContent = 'Depositing USDC... (Confirm in MetaMask)';
        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const depositTx = await escrowContract.deposit(tradeIdBytes32, currentTrade.buyer_wallet, amount);

        if (btn) btn.textContent = 'Waiting for Deposit transaction...';
        await depositTx.wait();

        alert('USDC deposited into escrow successfully!');
        reloadTradeAfterTx();
    } catch (err) {
        alert('Escrow deposit failed: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function confirmFiatOnChain() {
    if (!confirm('Have you sent the KRW to the seller\'s account? Once confirmed on-chain, the seller cannot request a refund.')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('Escrow contract address is not configured.');
            return;
        }

        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Confirming payment... (Confirm in MetaMask)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.confirmFiat(tradeIdBytes32);

        if (btn) btn.textContent = 'Waiting for transaction confirmation...';
        await tx.wait();

        alert('Payment confirmed! Recorded on-chain.');
        reloadTradeAfterTx();
    } catch (err) {
        alert('Payment confirmation failed: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function releaseFromEscrow() {
    if (!confirm('Have you verified the KRW payment? This will release USDC to the buyer.')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('Escrow contract address is not configured.');
            return;
        }

        const btn = document.querySelector('#actions .btn-green');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Releasing USDC... (Confirm in MetaMask)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.release(tradeIdBytes32);

        if (btn) btn.textContent = 'Waiting for Release transaction...';
        await tx.wait();

        alert('USDC released successfully!');
        reloadTradeAfterTx();
    } catch (err) {
        alert('Release failed: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function refundFromEscrow() {
    if (!confirm('Do you want to request a refund for the USDC in escrow?')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('Escrow contract address is not configured.');
            return;
        }

        const btn = document.querySelector('#actions .btn-red');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Refunding USDC... (Confirm in MetaMask)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.refund(tradeIdBytes32);

        if (btn) btn.textContent = 'Waiting for Refund transaction...';
        await tx.wait();

        alert('USDC refunded successfully!');
        reloadTradeAfterTx();
    } catch (err) {
        alert('Refund failed: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function claimByBuyer() {
    if (!confirm('The seller has not responded for over 24 hours. Reclaim the USDC now?')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('Escrow contract address is not configured.');
            return;
        }

        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Reclaiming USDC... (Confirm in MetaMask)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.claimByBuyer(tradeIdBytes32);

        if (btn) btn.textContent = 'Waiting for transaction confirmation...';
        await tx.wait();

        alert('USDC reclaimed successfully!');
        reloadTradeAfterTx();
    } catch (err) {
        alert('USDC reclaim failed: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

// ---- Render actions based on role and status ----

function renderActions(trade) {
    const el = document.getElementById('actions');
    el.innerHTML = '';
    const isSeller = currentRole === 'seller';
    const isBuyer = currentRole === 'buyer';

    if (trade.status === 'created') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-info">
                    Trade has been created. Waiting for the buyer to join...
                </div>
            `;
        }
    } else if (trade.status === 'joined') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-info">
                    The buyer has joined the trade.<br>
                    Please deposit <strong>${trade.usdc_amount} USDC</strong> into escrow using MetaMask.
                </div>
                <button class="btn btn-primary btn-block" onclick="depositToEscrow()">
                    Deposit USDC into Escrow via MetaMask
                </button>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-info">
                    You have joined the trade.<br>
                    The seller will deposit USDC into escrow shortly. Please wait.
                </div>
            `;
        }
    } else if (trade.status === 'usdc_escrowed') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    USDC has been deposited into escrow.<br>
                    Waiting for the buyer's KRW payment.
                </div>
                <button class="btn btn-red btn-block" onclick="refundFromEscrow()" style="margin-top:12px">
                    Request Refund USDC
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * Refund will be unavailable once the buyer confirms payment
                </small>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    The seller has deposited USDC into escrow.
                </div>
                <div class="alert alert-warning">
                    <strong>Please send payment to the account below</strong><br><br>
                    Bank: ${trade.bank_name}<br>
                    Account Number: <strong>${trade.bank_account}</strong><br>
                    Amount: <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong>
                </div>
                <button class="btn btn-primary btn-block" onclick="confirmFiatOnChain()">
                    Payment Sent (Confirm On-Chain via MetaMask)
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * Once confirmed on-chain, the seller cannot refund. If no response within 24 hours, you can reclaim the USDC.
                </small>
            `;
        }
    } else if (trade.status === 'fiat_sent') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    The buyer has confirmed a payment of <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong> on-chain.<br>
                    Please verify the payment in your bank app and release the USDC.
                </div>
                <button class="btn btn-green btn-block" onclick="releaseFromEscrow()">
                    Confirm Payment & Release USDC
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * Refund unavailable — the buyer has confirmed the KRW payment on-chain.
                </small>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    Payment confirmation has been recorded on-chain.<br>
                    Please wait for the seller to verify the payment and release the USDC.
                </div>
                <div class="alert alert-info" style="margin-top:12px">
                    If the seller does not respond within 24 hours, you can reclaim the USDC using the button below.
                </div>
                <button class="btn btn-primary btn-block" onclick="claimByBuyer()">
                    Reclaim USDC (Available after 24 hours)
                </button>
            `;
        }
    } else if (trade.status === 'completed') {
        el.innerHTML = `<div class="alert alert-success">Trade completed successfully.</div>`;
    } else if (trade.status === 'refunded') {
        el.innerHTML = `<div class="alert alert-info">USDC has been refunded to the seller from escrow.</div>`;
    } else if (trade.status === 'expired' || trade.status === 'cancelled') {
        el.innerHTML = `<div class="alert" style="background:#3a1a1a;color:#ef5350;">Trade has been expired/cancelled.</div>`;
    }
}

function copyText(text) {
    navigator.clipboard.writeText(text);
}

// ---- WebSocket ----

function connectWebSocket(tradeId) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (ws) ws.close();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/${tradeId}`);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'trade_update') {
            currentTrade = msg.trade;
            const shareScreen = document.getElementById('screen-share');
            if (shareScreen.classList.contains('active') && msg.trade.status === 'joined') {
                showTradeScreen(msg.trade);
            } else {
                updateTradeUI(msg.trade);
            }
        }
    };
    ws.onclose = () => {
        ws = null;
        setTimeout(() => connectWebSocket(tradeId), 3000);
    };
}

// ---- Helpers ----

function statusLabel(s) {
    const map = {
        created: 'Created', joined: 'Joined', usdc_escrowed: 'USDC in Escrow',
        fiat_sent: 'KRW Payment Received', completed: 'Completed', refunded: 'Refunded',
        expired: 'Expired', cancelled: 'Cancelled'
    };
    return map[s] || s;
}

function startCountdown(expiresAt) {
    clearInterval(countdownInterval);
    const update = () => {
        const diff = new Date(expiresAt) - new Date();
        if (diff <= 0) {
            document.getElementById('t-expires').textContent = 'Expired';
            clearInterval(countdownInterval);
            return;
        }
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        document.getElementById('t-expires').textContent = `${m}m ${s}s`;
    };
    update();
    countdownInterval = setInterval(update, 1000);
}
