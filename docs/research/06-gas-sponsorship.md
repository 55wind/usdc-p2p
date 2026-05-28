# PDF 6번 — 모든 거래의 가스비를 서버 측 지갑에서 부담

작성일: 2026-05-13
대상 PDF: `Lumos_UX_Improvement_May2026.pdf` §6

## 목표

사용자는 POL/MATIC을 직접 보유하지 않는다. USDC만 가지고도 deposit, confirmFiat, release,
refund, claimByBuyer 모든 트랜잭션이 실행되어야 한다. 가스비는 Lumos가 운영하는 서버 측
MetaMask 지갑이 부담한다.

## 현재 컨트랙트의 제약

`contracts/USDCEscrow.sol`이 모든 권한 검증을 `msg.sender`로 수행한다:

- `deposit` → `msg.sender`가 seller가 됨
- `confirmFiat` → `require(msg.sender == t.buyer)`
- `release` → `require(msg.sender == t.seller)`
- `refund` → `require(msg.sender == t.seller)`
- `claimByBuyer` → `require(msg.sender == t.buyer)`

**즉, 단순 relayer (서버가 트랜잭션 보내고 user 주소를 calldata로만 넘김) 방식은 동작 안 함.**
서버가 보내면 `msg.sender = 서버 지갑`이 되므로 권한 검증 실패.

→ 컨트랙트 수정이 어떤 형태로든 필요하다.

## 옵션 비교

### 옵션 A — EIP-2771 Meta-Transaction (TrustedForwarder)

**개념:**
- ERC-2771 표준의 `MinimalForwarder` 컨트랙트를 배포
- USDCEscrow를 `ERC2771Context`를 상속하도록 수정 → `_msgSender()` 사용
- 사용자가 호출 데이터에 EIP-712 서명 → Lumos 서버가 forwarder를 통해 relay
- forwarder가 escrow를 호출할 때 calldata 끝에 user 주소를 붙임 → `_msgSender()`가 그 주소를 반환

**컨트랙트 변경:**
```solidity
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract USDCEscrow is ERC2771Context {
    constructor(address _usdc, address _platform, address _trustedForwarder)
        ERC2771Context(_trustedForwarder) { ... }

    // 모든 msg.sender → _msgSender()
    function release(bytes32 tradeId) external {
        require(_msgSender() == t.seller, "not seller");
        ...
    }
}
```

**필요한 인프라:**
- TrustedForwarder 컨트랙트 배포 (OpenZeppelin 표준 사용 — 변경 거의 없음)
- 서버에 relay 엔드포인트: 사용자 EIP-712 서명을 받아 forwarder의 `execute()` 호출
- 서버 지갑에 POL 충전 + 모니터링

**유저 흐름:**
1. 사용자가 trade.js에서 "Release" 버튼 클릭
2. JS가 EIP-712 typed-data 만들어서 `eth_signTypedData_v4`로 서명 요청
3. MetaMask 팝업이 뜨지만 **가스비는 0 / 무료**라고 표시됨 (서명만)
4. 서명 결과를 Lumos 서버로 POST
5. 서버가 forwarder에 보내고 영수증 반환
6. JS가 영수증으로 polling 또는 WS로 상태 업데이트

**장점:**
- 표준이고 도구가 많음 (OpenZeppelin Defender, Biconomy, Gelato 모두 지원)
- USDCEscrow 코드 거의 그대로, msg.sender → _msgSender() 치환만
- 사용자 EOA 그대로 사용 — 마이그레이션 없음

**단점:**
- **컨트랙트 재배포 필수** — 기존 escrow와 호환 안 됨
- approval(USDC.approve) 호출도 메타 트랜잭션화하려면 USDC 컨트랙트가 EIP-2612 permit을 지원해야 함 → **다행히 Polygon native USDC는 permit 지원**
- 사용자가 EIP-712 서명을 이해해야 함 (MetaMask가 "사이트가 무엇을 하려는지" 잘 보여주긴 함)

**난이도:** 중. 컨트랙트 수정 + relay 서버 + 클라이언트 서명 흐름 = 5–10일 작업
**비용:** 서버 지갑에 POL 채워두는 운영비. 트랜잭션당 ~0.01–0.05 POL.

### 옵션 B — Account Abstraction (ERC-4337)

**개념:**
- 사용자 EOA 대신 **Smart Account** (예: Safe, Biconomy SCA, ZeroDev)를 발급
- Paymaster 컨트랙트가 가스비를 대신 지불
- `UserOperation` mempool 사용

**컨트랙트 변경:**
- USDCEscrow는 거의 그대로 사용 가능 — Smart Account가 msg.sender가 되도록 동작
- 단, "seller/buyer는 Smart Account 주소" 라는 모델로 시작부터 일관

**필요한 인프라:**
- AA Bundler (Pimlico, Alchemy, Biconomy 등 SaaS)
- Paymaster 컨트랙트 + 잔액 관리
- Smart Account 팩토리 — 사용자가 로그인 시 자동 발급
- 보통 SDK: ZeroDev, Biconomy, Safe{Core}, Privy

**유저 흐름:**
1. 사용자 첫 진입 → 소셜 로그인 또는 EOA로 Smart Account 자동 생성
2. Smart Account에 USDC 입금 (또는 첫 거래 때 fund)
3. 모든 액션은 Smart Account의 `executeUserOp` → paymaster가 가스 지불
4. POL/가스 개념은 완전히 사라짐

**장점:**
- PDF 철학 ("crypto를 숨긴다")에 가장 잘 부합 — wallet/chain/gas/token 모두 숨길 수 있음
- 소셜로그인 가능 → MetaMask 없는 사용자도 onboard
- 한 번 통합하면 모든 트랜잭션에 일괄 적용 (approve, deposit, release 다 무료)
- 세션키 / 자동승인 등 고급 UX 가능

**단점:**
- **큰 아키텍처 변경** — Smart Account 주소로 마이그레이션 필요
- 기존 EOA 사용자의 자금/거래 이력 호환 안 됨 (또는 import 단계 필요)
- 비용 더 큼 — Bundler/Paymaster SaaS 월 구독 (Pimlico ~$50–500/mo, Biconomy 차등)
- 가스비 자체는 더 높음 (UserOp는 일반 tx보다 1.5–3x 가스)
- 디버깅 어려움 — UserOp revert는 일반 tx보다 추적이 까다로움

**난이도:** 크다. SDK 통합 + 컨트랙트 검토 + UX 재설계 + 마이그레이션 = 2–4주 작업
**비용:** SaaS 구독 + Paymaster fund + 트랜잭션당 가스 1.5–3x.

### 옵션 C — 커스텀 메타 트랜잭션 (서명 검증을 컨트랙트에 직접 구현)

**개념:**
- ERC-2771을 쓰지 않고 직접 EIP-712 서명을 받는 함수 추가
- 예: `releaseSigned(bytes32 tradeId, address actor, bytes signature)` 형태
- 컨트랙트가 서명을 ecrecover로 검증, actor를 seller/buyer로 사용

**장점:**
- 외부 forwarder 없음, nonce 등 모두 컨트랙트 내부 관리 → 의존성 적음
- 표준 라이브러리 없이 가장 단순

**단점:**
- **재구현 = 버그 위험**. 표준 ERC-2771이 안전하고 검증됨
- 같은 시간 비용으로 옵션 A가 더 나음
- 추후 다른 dapp/표준과 통합 안 됨

**난이도:** 중. 직접 구현하는 만큼 감사도 직접 해야 함.

→ **비추천.** 옵션 A의 마이너 변형이지만 표준 이탈만 발생.

### 옵션 D — 커스터디얼 (Lumos가 자금을 보관)

**개념:**
- 사용자는 Lumos 계정만 만들고 USDC를 Lumos에 입금
- 모든 거래는 Lumos 내부 DB로 처리, 정산 시점에만 on-chain
- 사용자는 지갑 자체가 없음

**장점:**
- crypto가 완전히 숨겨짐
- 가스비도 우리만 부담

**단점:**
- **규제 리스크 매우 큼** — 한국 가상자산사업자(VASP) 신고 필요 가능
- 책임 100% Lumos가 짐 (해킹 시 회사 책임)
- "non-custodial protocol"이라는 footer 문구와 정면 충돌
- 보험, 감사, 콜드월렛 운영 등 별도 인프라 비용

**난이도:** 매우 큼. 사실상 다른 회사.

→ **장기적으로 다른 트랙. 이번 항목 범위 아님.**

## 비교 요약

| 옵션 | 컨트랙트 변경 | 인프라 | 사용자 마이그레이션 | 난이도 | crypto 은닉도 |
| --- | --- | --- | --- | --- | --- |
| A. EIP-2771 | 작음 (상속 + msg.sender 치환) | Forwarder + relay 서버 | 없음 | 중 | 중 (서명 팝업은 남음, 가스는 0) |
| B. ERC-4337 | 거의 없음 | Bundler+Paymaster+SCA | 큼 (Smart Account로 이전) | 큼 | 높음 (PDF 철학에 최적) |
| C. 커스텀 메타tx | 큼 (서명 검증 직접 구현) | relay 서버 | 없음 | 중 | 중 |
| D. 커스터디얼 | 거의 없음 | DB + KYC + 보안 인프라 | 매우 큼 (계정 모델 변경) | 매우 큼 | 매우 높음 |

## 1차 추천

**단기 (1–2개월): 옵션 A (EIP-2771)**
이유:
- 기존 EOA 기반 모델 유지, 사용자 이탈 없음
- 컨트랙트 변경이 작음 (msg.sender → _msgSender() 치환 + 생성자 인자 1개 추가)
- approve도 USDC permit을 결합하면 deposit이 1 서명 1 트랜잭션으로 가능
- OpenZeppelin + Defender / Gelato 같은 SaaS로 운영 부담 최소화
- 한 번 만들면 "가스는 무료" 경험을 모든 거래에 즉시 적용

**장기 (3–6개월): 옵션 B (AA)로 진화 검토**
이유:
- PDF의 "wallet/chain/gas/token 다 숨긴다" 철학은 결국 AA에 도달
- Privy + ZeroDev 또는 Privy + Pimlico 조합이 onboarding부터 가스 추상화까지 일관 제공
- 신규 사용자는 소셜로그인 → Smart Account, 기존 EOA 사용자는 EIP-2771 호환 모드 유지
- 듀얼 모드로 운영하다가 신규가 다수가 되면 AA가 기본값

## 옵션 A 작업 분해 (참고)

만약 옵션 A로 간다고 결정한다면:

1. **컨트랙트 — 1~2일**
   - `USDCEscrow.sol`에 `ERC2771Context` 상속, `msg.sender` → `_msgSender()` 치환
   - 생성자에 `_trustedForwarder` 인자 추가
   - OpenZeppelin `MinimalForwarder`를 배포
2. **서버 — 2~3일**
   - `POST /api/relay` 엔드포인트: typed-data 서명을 받아 forwarder에 보냄
   - 서버 지갑(POL 보유)로 트랜잭션 서명 + 전송
   - rate limit + 서명 재사용 방지 (forwarder가 nonce 관리)
3. **클라이언트 — 2~3일**
   - `trade.js`의 각 액션을 직접 컨트랙트 호출 대신 EIP-712 서명 + relay 호출로 교체
   - POL 잔액 감지 카드 제거 (더 이상 필요 없음)
   - "Approve USDC" 단계를 EIP-2612 permit으로 묶어 deposit 1회 서명화
4. **운영 — 지속**
   - 서버 지갑 POL 잔액 알림 (예: < 10 POL 시 슬랙)
   - relay 실패 시 fallback (사용자가 직접 보낼 수 있는 옵션)
5. **테스트 — 1~2일**
   - mumbai/amoy 테스트넷에서 전체 흐름 테스트
   - 서명 위변조, 재사용, 잘못된 typed-data 검증

총 **8–13일 작업 분량** (1명 기준).

## 결론 (1줄)

당장은 옵션 A로 EIP-2771 도입 → 사용자는 USDC만 가지면 됨,
서명은 1회로 줄이고 POL/가스 개념은 UI에서 완전히 제거. 장기적으로는 AA로 진화.
