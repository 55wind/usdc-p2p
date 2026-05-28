# PDF 5번 — Transak 위젯 통합 시 서비스 변화

작성일: 2026-05-13
대상 PDF: `Lumos_UX_Improvement_May2026.pdf` §5

## 현재 흐름 (MetaMask Portfolio)

- `lumos.js`의 `buyUsdcLink(wallet, amount)` → `portfolio.metamask.io/buy/build-quote?...`
- 사용자가 새 탭에서 MetaMask Portfolio로 이동 → 거기서 다시 Transak/MoonPay 등 공급자를 선택해 결제
- 우리 서비스 입장에서는 단순 외부 링크. 통합 없음, 수수료 분배 없음, 콜백 없음.

| 항목 | 현재 (MetaMask Portfolio) |
| --- | --- |
| 사용자 이동 | 외부 도메인 새 탭 |
| 결제 공급자 선택 | 사용자가 Portfolio에서 직접 선택 |
| 자동 채움 | token=USDC, chain=137, amount, address |
| KYC | 공급자가 처리 (우리와 무관) |
| 결제 수단 | 신용카드, 계좌이체, Apple Pay 등 (공급자 따라) |
| 우리 수익 | 0 (referral fee 없음) |
| 결제 완료 통지 | 없음 — 사용자가 돌아와서 잔액으로 확인해야 함 |
| 평균 이탈률 | 추정 높음 — 도메인 전환 + 두 번의 선택 단계 |

## Transak 위젯으로 바꿨을 때 변하는 것

### A. 사용자 경험

- **도메인 전환 사라짐**: Lumos 페이지 안에 iframe(또는 모달)으로 Transak이 뜸
- **공급자 선택 단계 사라짐**: Transak 단독이라 사용자는 결제 수단만 선택
- **Apple Pay / Google Pay 즉시 노출**: 한국 카드도 받음 (Transak이 KR 시장 비교적 강함)
- **자동 채움 동일**: cryptoCurrencyCode=USDC, network=polygon, fiatAmount=, walletAddress= 모두 사전 설정 가능
- **완료 콜백 가능**: Transak SDK가 `ORDER_COMPLETED` 이벤트를 발행 → 우리가 즉시 "잔액 새로고침" 가능
- **연속 흐름**: trade 페이지에서 USDC 부족 감지 → Transak 모달 → 결제 → 자동으로 deposit 단계로 진행 가능

### B. 우리가 해야 하는 일

1. **Transak 계정 가입 + API Key 발급**
   - Staging key (테스트), Production key (실거래)
   - 회사 정보 / 도메인 인증 필요 (Lumos 도메인이 있어야 함)
2. **위젯 임베드**
   - `@transak/transak-sdk` npm 패키지 또는 직접 iframe URL 빌드
   - 옵션 예시:
     ```js
     {
       apiKey: TRANSAK_API_KEY,
       environment: 'PRODUCTION',
       cryptoCurrencyCode: 'USDC',
       network: 'polygon',
       walletAddress: account,
       fiatAmount: shortageInUSD,   // 또는 fiatCurrency: 'KRW' + 환산
       defaultPaymentMethod: 'credit_debit_card',
       disableWalletAddressForm: true,  // 사용자가 주소 못 바꾸게
       hideMenu: true,
       themeColor: '#0F172A',
     }
     ```
3. **이벤트 핸들링**
   - `TRANSAK_ORDER_SUCCESSFUL` → 잔액 재조회 (10–30초 polling)
   - `TRANSAK_WIDGET_CLOSE` → 모달 닫고 원래 UI 복구
4. **CSP 업데이트**
   - `frame-src https://global.transak.com https://global-stg.transak.com`
   - 현재 base.html에 CSP 헤더는 없음 → 추가하지 않으면 그대로 동작하지만, 추후 보안 강화 시 화이트리스트 필요
5. **법적 검토**
   - Transak이 KYC/AML 책임을 짐. 우리는 "On/Off-ramp는 Transak이 제공" 명시 필수
   - 약관에 third-party provider 조항 추가
6. **수수료 협상 (선택)**
   - Transak partner fee revenue share — 기본 0%, 거래량에 따라 분배 가능
   - 협상 가능 시 거래액의 0.5~1.0% 수익 발생 (Lumos 자체 수수료와 별개)

### C. 비용 영향

| 항목 | 현재 | Transak 직접 통합 |
| --- | --- | --- |
| 사용자 결제 수수료 | 공급자 1.5–4.5% (사용자 부담) | Transak 0.99–4.0% (사용자 부담, 결제수단별) |
| Lumos 수익 | 0 | 0 또는 partner share (협상 시) |
| 운영 비용 | 0 | 약간 — SDK 유지보수, 위젯 디버깅 |

### D. 위험 / 트레이드오프

- **공급자 단일화 = 단일 장애점**: MetaMask Portfolio는 여러 공급자 풀이라 한 군데 막혀도 다른 옵션 보임. Transak만 쓰면 Transak이 KR 사용자 거부 시 대안 없음.
  - 완화책: Transak을 1차로, 실패/거부 시 Portfolio 링크를 폴백으로 노출
- **KYC 강도**: Transak은 결제액 따라 KYC 단계가 다름 (소액은 이메일만, 큰 액수는 ID + 셀카). 일부 사용자가 중간에 이탈 가능
- **승인 시간**: Transak 계정 승인에 영업일 3–7일 (도메인 확인, 회사 인증)
- **모바일 인앱 브라우저**: MetaMask 인앱에서 Transak iframe이 동작하는지 별도 확인 필요 — 일부 인앱은 third-party 결제 차단

### E. 추천 통합 단계

1. **Phase 1 — Staging 통합 (1–2일)**
   - Transak staging key로 sell 페이지 / trade 페이지에 모달 임베드
   - `shortage` 자동 채움 + 완료 콜백으로 잔액 새로고침
2. **Phase 2 — A/B 테스트 (1–2주)**
   - 사용자 50%: 기존 Portfolio 링크
   - 사용자 50%: Transak 모달
   - KPI: 온램프 완료율, 평균 결제 금액, deposit 단계 도달률
3. **Phase 3 — 전면 전환 또는 듀얼 옵션**
   - Transak이 명백히 우세하면 기본값으로 승격, Portfolio는 "다른 방법" 링크로 격하
   - 동률이거나 Transak이 일부 사용자 거부하면 둘 다 노출

### F. 비교: 다른 후보 (간단)

- **Privy**: 본질은 임베디드 wallet (소셜로그인 → 자동 EOA 생성). 온램프는 부가 기능. 6번 항목(가스 대납) 함께 고려 시 시너지 큼.
- **Stripe Onramp**: Polygon USDC 지원하지만 미국 외 지역 커버리지가 약함. KR 사용자에 부적합.
- **Coinbase Pay**: Coinbase 계정 보유자만 우대. 일반 KR 사용자에 진입장벽 큼.
- **MoonPay**: Transak과 가장 유사한 위젯형. KR 결제수단 제한적이라는 평이 있음.

→ **단독 통합 1위 = Transak**, 2위 = MoonPay (폴백).

## 한 줄 요약

Transak으로 바꾸면 "외부 도메인으로 보내는 링크"가 "Lumos 안에서 닫힌 결제 모달"이 되고,
완료 콜백으로 deposit 단계까지 자연스럽게 이어진다. 비용은 거의 동일하나
API Key 발급 + 약관 정비 + 모달 UX 작업이 필요하다.
