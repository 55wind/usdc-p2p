// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract USDCEscrow {
    IERC20 public immutable usdc;
    uint256 public constant AUTO_RELEASE_TIMEOUT = 24 hours;

    struct Trade {
        address seller;
        address buyer;
        uint256 amount;
        bool active;
        bool fiatConfirmed;
        uint256 fiatConfirmedAt;
    }

    mapping(bytes32 => Trade) public trades;

    event Deposited(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount);
    event FiatConfirmed(bytes32 indexed tradeId, address indexed buyer);
    event Released(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount);
    event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event BuyerClaimed(bytes32 indexed tradeId, address indexed buyer, uint256 amount);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    /// @notice 판매자가 USDC를 에스크로에 입금
    function deposit(bytes32 tradeId, address buyer, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(buyer != address(0), "Invalid buyer");
        require(!trades[tradeId].active, "Trade already exists");

        trades[tradeId] = Trade({
            seller: msg.sender,
            buyer: buyer,
            amount: amount,
            active: true,
            fiatConfirmed: false,
            fiatConfirmedAt: 0
        });

        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        emit Deposited(tradeId, msg.sender, buyer, amount);
    }

    /// @notice 구매자가 KRW 송금 후 온체인에서 확인 (이후 refund 차단)
    function confirmFiat(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "Trade not active");
        require(msg.sender == t.buyer, "Only buyer");
        require(!t.fiatConfirmed, "Already confirmed");

        t.fiatConfirmed = true;
        t.fiatConfirmedAt = block.timestamp;

        emit FiatConfirmed(tradeId, msg.sender);
    }

    /// @notice 판매자가 USDC를 구매자에게 전송 (정상 완료)
    function release(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "Trade not active");
        require(msg.sender == t.seller, "Only seller");

        t.active = false;
        uint256 amount = t.amount;
        address buyer = t.buyer;

        require(usdc.transfer(buyer, amount), "Transfer failed");

        emit Released(tradeId, msg.sender, buyer, amount);
    }

    /// @notice 판매자가 USDC 환불 (fiat 확인 전에만 가능)
    function refund(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "Trade not active");
        require(msg.sender == t.seller, "Only seller");
        require(!t.fiatConfirmed, "Fiat confirmed, cannot refund");

        t.active = false;
        uint256 amount = t.amount;

        require(usdc.transfer(t.seller, amount), "Transfer failed");

        emit Refunded(tradeId, msg.sender, amount);
    }

    /// @notice 구매자가 USDC 직접 회수 (fiat 확인 후 24시간 경과 + 판매자 미응답)
    function claimByBuyer(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "Trade not active");
        require(msg.sender == t.buyer, "Only buyer");
        require(t.fiatConfirmed, "Fiat not confirmed");
        require(block.timestamp >= t.fiatConfirmedAt + AUTO_RELEASE_TIMEOUT, "Timeout not reached");

        t.active = false;
        uint256 amount = t.amount;

        require(usdc.transfer(t.buyer, amount), "Transfer failed");

        emit BuyerClaimed(tradeId, msg.sender, amount);
    }
}
