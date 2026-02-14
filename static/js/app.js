let currentTrade = null;
let currentRole = null; // 'seller' or 'buyer'
let ws = null;
let countdownInterval = null;

// Routing
function navigateTo(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${screen}`).classList.add('active');
}

// Check URL for trade ID on load
window.addEventListener('load', () => {
    const path = window.location.pathname;
    const match = path.match(/^\/trade\/([a-f0-9-]+)$/);
    if (match) {
        const tradeId = match[1];
        // Check if we're the seller for this trade
        const savedRole = localStorage.getItem(`role_${tradeId}`);
        if (savedRole) {
            currentRole = savedRole;
        }
        loadTrade(tradeId);
    }

});

// API helpers
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

// Create trade (seller)
async function createTrade(e) {
    e.preventDefault();
    try {
        const trade = await api('POST', '/trades', {
            seller_wallet: document.getElementById('seller-wallet').value,
            usdc_amount: parseFloat(document.getElementById('usdc-amount').value),
            total_krw: parseFloat(document.getElementById('total-krw').value),
        });
        currentTrade = trade;
        currentRole = 'seller';
        localStorage.setItem(`role_${trade.id}`, 'seller');

        const url = `${window.location.origin}/trade/${trade.id}`;
        document.getElementById('share-url').value = url;
        navigateTo('share');

        // Connect WebSocket on share screen so seller gets notified when buyer joins
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

// Load trade by ID
async function loadTrade(tradeId) {
    try {
        const trade = await api('GET', `/trades/${tradeId}`);
        currentTrade = trade;

        // If no saved role, and status is 'created', this is the buyer arriving
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
        alert('거래를 찾을 수 없습니다.');
        navigateTo('home');
    }
}

// Join screen (buyer)
function showJoinScreen(trade) {
    const info = document.getElementById('join-info');
    info.innerHTML = `
        <div class="info-row"><span>USDC 수량</span><span>${trade.usdc_amount} USDC</span></div>
        <div class="info-row"><span>총 금액</span><span>${Number(trade.total_krw).toLocaleString()} KRW</span></div>
        <div class="info-row"><span>판매자 지갑</span><span class="mono">${trade.seller_wallet}</span></div>
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

// Trade status screen
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

    // TX hash
    const txRow = document.getElementById('row-txhash');
    if (trade.tx_hash) {
        txRow.style.display = 'flex';
        document.getElementById('t-txhash').innerHTML =
            `<a href="https://polygonscan.com/tx/${trade.tx_hash}" target="_blank" style="color:var(--accent)">${trade.tx_hash.slice(0, 16)}...</a>`;
    } else {
        txRow.style.display = 'none';
    }

    // Virtual account - only show to buyer
    const vaRow = document.getElementById('row-va');
    if (trade.toss_account_number && currentRole === 'buyer') {
        vaRow.style.display = 'flex';
        document.getElementById('t-va').textContent = `${bankName(trade.toss_bank_code)} ${trade.toss_account_number}`;
    } else {
        vaRow.style.display = 'none';
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
    const steps = ['created', 'joined', 'usdc_sent', 'fiat_deposited', 'completed'];
    const idx = steps.indexOf(trade.status);
    steps.forEach((s, i) => {
        const el = document.getElementById(`step-${s}`);
        el.className = 'step';
        if (i < idx) el.classList.add('done');
        else if (i === idx) el.classList.add('active');
    });

    // Actions (role-aware)
    renderActions(trade);
}

function renderActions(trade) {
    const el = document.getElementById('actions');
    el.innerHTML = '';
    const isSeller = currentRole === 'seller';
    const isBuyer = currentRole === 'buyer';

    if (trade.status === 'created') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-info">
                    거래가 생성되었습니다. 구매자가 참여하기를 기다리고 있습니다...
                </div>
            `;
        }
    } else if (trade.status === 'joined') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-info">
                    상대방이 거래에 참여했습니다.<br>
                    아래 주소로 <strong>${trade.usdc_amount} USDC</strong>를 보내주세요. (제한시간 20분)
                </div>
                <div class="wallet-box">
                    <span class="mono">${trade.buyer_wallet}</span>
                    <button class="btn btn-secondary btn-sm" onclick="copyText('${trade.buyer_wallet}')">복사</button>
                </div>
                <button class="btn btn-primary btn-block" onclick="confirmUsdc()">USDC 전송 완료 확인</button>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-info">
                    거래에 참여했습니다.<br>
                    판매자가 USDC를 전송 중입니다. 잠시만 기다려주세요...
                </div>
                <div class="loading-spinner"></div>
            `;
        }
    } else if (trade.status === 'usdc_sent') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    USDC 전송이 확인되었습니다.<br>
                    구매자의 KRW 입금을 기다리고 있습니다...
                </div>
                <div class="loading-spinner"></div>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    판매자가 USDC를 전송했습니다!
                </div>
                ${trade.toss_account_number ? `
                <div class="alert alert-warning">
                    <strong>아래 계좌로 입금해주세요 (제한시간 20분)</strong><br><br>
                    은행: ${bankName(trade.toss_bank_code)}<br>
                    계좌번호: <strong>${trade.toss_account_number}</strong><br>
                    금액: <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong>
                </div>
                ` : `
                <div class="alert alert-info">가상계좌를 생성 중입니다...</div>
                `}
            `;
        }
    } else if (trade.status === 'fiat_deposited') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    구매자가 <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong>을 입금했습니다.<br>
                    입금을 확인해주세요.
                </div>
                <button class="btn btn-green btn-block" onclick="releaseTrade()">입금 확인 완료 — 거래 완료</button>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    입금이 확인되었습니다!<br>
                    판매자가 입금을 확인하고 있습니다. 잠시만 기다려주세요...
                </div>
                <div class="loading-spinner"></div>
            `;
        }
    } else if (trade.status === 'completed') {
        el.innerHTML = `<div class="alert alert-success">거래가 성공적으로 완료되었습니다!</div>`;
    } else if (trade.status === 'expired' || trade.status === 'cancelled') {
        el.innerHTML = `<div class="alert" style="background:#3a1a1a;color:#ef5350;">거래가 만료/취소되었습니다.</div>`;
    }
}

function copyText(text) {
    navigator.clipboard.writeText(text);
}

async function confirmUsdc() {
    try {
        await api('POST', `/trades/${currentTrade.id}/confirm-usdc`);
    } catch (err) {
        alert(err.message);
    }
}

async function releaseTrade() {
    if (!confirm('KRW 입금을 확인하셨나요? 거래를 완료합니다.')) return;
    try {
        const trade = await api('POST', `/trades/${currentTrade.id}/release`);
        updateTradeUI(trade);
    } catch (err) {
        alert(err.message);
    }
}

// WebSocket
function connectWebSocket(tradeId) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (ws) ws.close();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/${tradeId}`);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'trade_update') {
            currentTrade = msg.trade;
            // If seller is on share screen and buyer joined, auto-move to trade screen
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

// Helpers
function statusLabel(s) {
    const map = {
        created: '대기중', joined: '참여됨', usdc_sent: 'USDC 전송됨',
        fiat_deposited: 'KRW 입금됨', completed: '완료', expired: '만료', cancelled: '취소'
    };
    return map[s] || s;
}

function bankName(code) {
    const banks = { '20': '우리은행', '88': '신한은행', '04': 'KB국민', '03': 'IBK기업' };
    return banks[code] || `은행(${code})`;
}

function startCountdown(expiresAt) {
    clearInterval(countdownInterval);
    const update = () => {
        const diff = new Date(expiresAt) - new Date();
        if (diff <= 0) {
            document.getElementById('t-expires').textContent = '만료됨';
            clearInterval(countdownInterval);
            return;
        }
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        document.getElementById('t-expires').textContent = `${m}분 ${s}초`;
    };
    update();
    countdownInterval = setInterval(update, 1000);
}
