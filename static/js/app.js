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
        throw new Error('MetaMask가 설치되어 있지 않습니다.');
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
        alert('거래를 찾을 수 없습니다.');
        navigateTo('home');
    }
}

// ---- Join screen (buyer) ----

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
            alert('에스크로 컨트랙트 주소가 설정되지 않았습니다.');
            return;
        }

        // Step 1: Approve
        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'USDC Approve 중... (MetaMask 확인)';
        }

        const currentAllowance = await usdcContract.allowance(account, escrowAddr);
        if (currentAllowance < amount) {
            const approveTx = await usdcContract.approve(escrowAddr, amount);
            if (btn) btn.textContent = 'Approve 트랜잭션 확인 대기 중...';
            await approveTx.wait();
        }

        // Step 2: Deposit
        if (btn) btn.textContent = 'USDC Deposit 중... (MetaMask 확인)';
        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const depositTx = await escrowContract.deposit(tradeIdBytes32, currentTrade.buyer_wallet, amount);

        if (btn) btn.textContent = 'Deposit 트랜잭션 확인 대기 중...';
        await depositTx.wait();

        const el = document.getElementById('actions');
        el.innerHTML = `
            <div class="alert alert-success">
                USDC가 에스크로에 입금되었습니다!<br>
                백엔드에서 확인 중입니다... 잠시만 기다려주세요.
            </div>
            <div class="loading-spinner"></div>
        `;
    } catch (err) {
        alert('에스크로 입금 실패: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function confirmFiatOnChain() {
    if (!confirm('판매자 계좌로 KRW를 송금하셨나요? 온체인에서 확인하면 판매자가 환불할 수 없습니다.')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('에스크로 컨트랙트 주소가 설정되지 않았습니다.');
            return;
        }

        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '입금 확인 중... (MetaMask 확인)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.confirmFiat(tradeIdBytes32);

        if (btn) btn.textContent = '트랜잭션 확인 대기 중...';
        await tx.wait();

        const el = document.getElementById('actions');
        el.innerHTML = `
            <div class="alert alert-success">
                입금 확인이 온체인에 기록되었습니다!<br>
                판매자가 USDC를 전송할 때까지 기다려주세요...<br>
                <small>판매자가 24시간 내 응답하지 않으면 직접 USDC를 회수할 수 있습니다.</small>
            </div>
            <div class="loading-spinner"></div>
        `;
    } catch (err) {
        alert('입금 확인 실패: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function releaseFromEscrow() {
    if (!confirm('KRW 입금을 확인하셨나요? USDC를 구매자에게 전송합니다.')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('에스크로 컨트랙트 주소가 설정되지 않았습니다.');
            return;
        }

        const btn = document.querySelector('#actions .btn-green');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Release 중... (MetaMask 확인)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.release(tradeIdBytes32);

        if (btn) btn.textContent = 'Release 트랜잭션 확인 대기 중...';
        await tx.wait();

        const el = document.getElementById('actions');
        el.innerHTML = `
            <div class="alert alert-success">
                USDC가 구매자에게 전송되었습니다!<br>
                백엔드에서 확인 중입니다...
            </div>
            <div class="loading-spinner"></div>
        `;
    } catch (err) {
        alert('Release 실패: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function refundFromEscrow() {
    if (!confirm('에스크로에 입금된 USDC를 환불받으시겠습니까?')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('에스크로 컨트랙트 주소가 설정되지 않았습니다.');
            return;
        }

        const btn = document.querySelector('#actions .btn-red');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Refund 중... (MetaMask 확인)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.refund(tradeIdBytes32);

        if (btn) btn.textContent = 'Refund 트랜잭션 확인 대기 중...';
        await tx.wait();

        const el = document.getElementById('actions');
        el.innerHTML = `
            <div class="alert alert-info">
                USDC가 환불되었습니다.<br>
                백엔드에서 확인 중입니다...
            </div>
            <div class="loading-spinner"></div>
        `;
    } catch (err) {
        alert('Refund 실패: ' + (err.reason || err.message));
        if (currentTrade) renderActions(currentTrade);
    }
}

async function claimByBuyer() {
    if (!confirm('판매자가 24시간 이상 응답하지 않아 USDC를 직접 회수합니다.')) return;
    try {
        const account = await connectMetaMask();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        const escrowAddr = ESCROW_ADDRESS;
        if (!escrowAddr) {
            alert('에스크로 컨트랙트 주소가 설정되지 않았습니다.');
            return;
        }

        const btn = document.querySelector('#actions .btn-primary');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'USDC 회수 중... (MetaMask 확인)';
        }

        const escrowContract = new ethers.Contract(escrowAddr, ESCROW_ABI, signer);
        const tradeIdBytes32 = uuidToBytes32(currentTrade.id);
        const tx = await escrowContract.claimByBuyer(tradeIdBytes32);

        if (btn) btn.textContent = '트랜잭션 확인 대기 중...';
        await tx.wait();

        const el = document.getElementById('actions');
        el.innerHTML = `
            <div class="alert alert-success">
                USDC를 회수했습니다!<br>
                백엔드에서 확인 중입니다...
            </div>
            <div class="loading-spinner"></div>
        `;
    } catch (err) {
        alert('USDC 회수 실패: ' + (err.reason || err.message));
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
                    거래가 생성되었습니다. 구매자가 참여하기를 기다리고 있습니다...
                </div>
            `;
        }
    } else if (trade.status === 'joined') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-info">
                    상대방이 거래에 참여했습니다.<br>
                    MetaMask로 <strong>${trade.usdc_amount} USDC</strong>를 에스크로에 입금하세요.
                </div>
                <button class="btn btn-primary btn-block" onclick="depositToEscrow()">
                    MetaMask로 USDC 에스크로 입금
                </button>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-info">
                    거래에 참여했습니다.<br>
                    판매자가 USDC를 에스크로에 입금 중입니다. 잠시만 기다려주세요...
                </div>
                <div class="loading-spinner"></div>
            `;
        }
    } else if (trade.status === 'usdc_escrowed') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    USDC가 에스크로에 입금되었습니다.<br>
                    구매자의 KRW 입금을 기다리고 있습니다...
                </div>
                <div class="loading-spinner"></div>
                <button class="btn btn-red btn-block" onclick="refundFromEscrow()" style="margin-top:12px">
                    환불 (USDC 돌려받기)
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * 구매자가 입금 확인을 하면 환불이 불가능합니다
                </small>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    판매자가 USDC를 에스크로에 입금했습니다!
                </div>
                <div class="alert alert-warning">
                    <strong>아래 계좌로 입금해주세요</strong><br><br>
                    은행: ${trade.bank_name}<br>
                    계좌번호: <strong>${trade.bank_account}</strong><br>
                    금액: <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong>
                </div>
                <button class="btn btn-primary btn-block" onclick="confirmFiatOnChain()">
                    입금 완료 (MetaMask로 온체인 확인)
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * 온체인 확인 후 판매자가 환불할 수 없으며, 24시간 미응답 시 직접 USDC를 회수할 수 있습니다
                </small>
            `;
        }
    } else if (trade.status === 'fiat_sent') {
        if (isSeller) {
            el.innerHTML = `
                <div class="alert alert-success">
                    구매자가 <strong>${Number(trade.total_krw).toLocaleString()} KRW</strong> 입금을 온체인에서 확인했습니다.<br>
                    은행 앱에서 입금을 확인한 후 USDC를 릴리즈하세요.
                </div>
                <button class="btn btn-green btn-block" onclick="releaseFromEscrow()">
                    입금 확인 — MetaMask로 USDC 전송
                </button>
                <small style="color:var(--text2);text-align:center;display:block;margin-top:4px">
                    * 환불 불가 — 구매자가 온체인에서 입금을 확인했습니다
                </small>
            `;
        } else if (isBuyer) {
            el.innerHTML = `
                <div class="alert alert-success">
                    입금 확인이 온체인에 기록되었습니다.<br>
                    판매자가 입금을 확인하고 USDC를 전송할 때까지 기다려주세요...
                </div>
                <div class="loading-spinner"></div>
                <div class="alert alert-info" style="margin-top:12px">
                    판매자가 24시간 내 응답하지 않으면 아래 버튼으로 USDC를 직접 회수할 수 있습니다.
                </div>
                <button class="btn btn-primary btn-block" onclick="claimByBuyer()">
                    USDC 직접 회수 (24시간 경과 후)
                </button>
            `;
        }
    } else if (trade.status === 'completed') {
        el.innerHTML = `<div class="alert alert-success">거래가 성공적으로 완료되었습니다!</div>`;
    } else if (trade.status === 'refunded') {
        el.innerHTML = `<div class="alert alert-info">에스크로에서 USDC가 판매자에게 환불되었습니다.</div>`;
    } else if (trade.status === 'expired' || trade.status === 'cancelled') {
        el.innerHTML = `<div class="alert" style="background:#3a1a1a;color:#ef5350;">거래가 만료/취소되었습니다.</div>`;
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
        created: '대기중', joined: '참여됨', usdc_escrowed: 'USDC 에스크로',
        fiat_sent: 'KRW 입금 확인됨', completed: '완료', refunded: '환불됨',
        expired: '만료', cancelled: '취소'
    };
    return map[s] || s;
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
