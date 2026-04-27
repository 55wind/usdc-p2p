// Lumos shared utilities — config, fetch wrapper, MetaMask helpers, onboarding state.

window.LUMOS = window.LUMOS || {};

// Polygon mainnet
const POLYGON_CHAIN_ID = '0x89';
const POLYGON_CHAIN_ID_DEC = 137;
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC on Polygon
const USDC_DECIMALS = 6;

// Minimal ABIs
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const ESCROW_ABI = [
  'function deposit(bytes32 tradeId, address buyer, uint256 amount, uint256 fee)',
  'function confirmFiat(bytes32 tradeId)',
  'function release(bytes32 tradeId)',
  'function refund(bytes32 tradeId)',
  'function claimByBuyer(bytes32 tradeId)',
];

window.LUMOS.POLYGON_CHAIN_ID = POLYGON_CHAIN_ID;
window.LUMOS.POLYGON_CHAIN_ID_DEC = POLYGON_CHAIN_ID_DEC;
window.LUMOS.USDC_ADDRESS = USDC_ADDRESS;
window.LUMOS.USDC_DECIMALS = USDC_DECIMALS;
window.LUMOS.ERC20_ABI = ERC20_ABI;
window.LUMOS.ESCROW_ABI = ESCROW_ABI;

// ---------- API helper ----------
window.LUMOS.api = async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Request failed (${res.status})`);
  }
  return res.json();
};

// ---------- Format ----------
window.LUMOS.fmtUSDC = (n) => {
  const x = Number(n) || 0;
  return x.toLocaleString(undefined, { maximumFractionDigits: 6 });
};
window.LUMOS.fmtKRW = (n) => Math.round(Number(n) || 0).toLocaleString();
window.LUMOS.short = (addr) => (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—');

// ---------- MetaMask environment ----------
window.LUMOS.isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
window.LUMOS.isInMetaMaskApp = () => /MetaMaskMobile/i.test(navigator.userAgent);
window.LUMOS.hasMetaMask = () => typeof window.ethereum !== 'undefined' && (window.ethereum.isMetaMask || (window.ethereum.providers && window.ethereum.providers.some(p => p.isMetaMask)));

window.LUMOS.metaMaskDeepLink = () => {
  // https://docs.metamask.io/wallet/how-to/use-mobile/
  const url = window.location.host + window.location.pathname + window.location.search;
  return `https://metamask.app.link/dapp/${url}`;
};

window.LUMOS.uuidToBytes32 = (uuid) => {
  const hex = uuid.replace(/-/g, '');
  return '0x' + hex.padEnd(64, '0');
};

window.LUMOS.connect = async function connect() {
  if (!window.ethereum) throw new Error('MetaMask not detected.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  return accounts[0];
};

window.LUMOS.switchToPolygon = async function switchToPolygon() {
  if (!window.ethereum) throw new Error('MetaMask not detected.');
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: POLYGON_CHAIN_ID }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: POLYGON_CHAIN_ID,
          chainName: 'Polygon Mainnet',
          nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
          rpcUrls: ['https://polygon-rpc.com'],
          blockExplorerUrls: ['https://polygonscan.com/'],
        }],
      });
    } else {
      throw err;
    }
  }
};

window.LUMOS.getChainId = async function getChainId() {
  if (!window.ethereum) return null;
  return await window.ethereum.request({ method: 'eth_chainId' });
};

window.LUMOS.getCurrentAccount = async function getCurrentAccount() {
  if (!window.ethereum) return null;
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  return accounts && accounts[0] ? accounts[0] : null;
};

// USDC + POL balance check via ethers
window.LUMOS.getBalances = async function getBalances(account) {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const [polWei, usdcRaw] = await Promise.all([
    provider.getBalance(account),
    new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).balanceOf(account),
  ]);
  return {
    pol: Number(ethers.formatEther(polWei)),
    usdc: Number(ethers.formatUnits(usdcRaw, USDC_DECIMALS)),
  };
};

// Build a Transak-style "Buy USDC on Polygon" link with token/network/wallet pre-filled.
// We use Transak's hosted widget — most wallets surface this CTA in MetaMask too.
window.LUMOS.buyUsdcLink = (wallet, amount) => {
  const params = new URLSearchParams({
    cryptoCurrencyCode: 'USDC',
    network: 'polygon',
    walletAddress: wallet || '',
    defaultCryptoAmount: String(amount || ''),
    isAutoFillUserData: 'true',
  });
  return `https://global.transak.com/?${params.toString()}`;
};

window.LUMOS.buyPolLink = (wallet) => {
  const params = new URLSearchParams({
    cryptoCurrencyCode: 'MATIC',
    network: 'polygon',
    walletAddress: wallet || '',
    defaultCryptoAmount: '5',
  });
  return `https://global.transak.com/?${params.toString()}`;
};

// Minimal toast (uses native alert as fallback for now; replaceable).
window.LUMOS.toast = (msg) => {
  // Simple inline notice — page-specific code can override.
  console.log('[lumos]', msg);
};
