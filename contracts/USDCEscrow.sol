// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title USDCEscrow — P2P escrow with platform fee borne by the seller.
/// @notice The seller deposits `amount + fee`. On release, the buyer receives
///         exactly `amount` and the platform wallet receives `fee`.
contract USDCEscrow {
    IERC20 public immutable usdc;
    address public immutable platform;
    uint256 public constant AUTO_RELEASE_TIMEOUT = 24 hours;

    struct Trade {
        address seller;
        address buyer;
        uint256 amount;          // net amount the buyer receives
        uint256 fee;             // platform fee, paid on release
        bool active;
        bool fiatConfirmed;
        uint256 fiatConfirmedAt;
    }

    mapping(bytes32 => Trade) public trades;

    event Deposited(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount, uint256 fee);
    event FiatConfirmed(bytes32 indexed tradeId, address indexed buyer);
    event Released(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount, uint256 fee);
    event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event BuyerClaimed(bytes32 indexed tradeId, address indexed buyer, uint256 amount);

    constructor(address _usdc, address _platform) {
        require(_platform != address(0), "platform=0");
        usdc = IERC20(_usdc);
        platform = _platform;
    }

    /// @notice Seller deposits `amount + fee` into escrow.
    function deposit(bytes32 tradeId, address buyer, uint256 amount, uint256 fee) external {
        require(amount > 0, "amount=0");
        require(buyer != address(0), "buyer=0");
        require(!trades[tradeId].active, "exists");

        trades[tradeId] = Trade({
            seller: msg.sender,
            buyer: buyer,
            amount: amount,
            fee: fee,
            active: true,
            fiatConfirmed: false,
            fiatConfirmedAt: 0
        });

        require(usdc.transferFrom(msg.sender, address(this), amount + fee), "transferFrom failed");
        emit Deposited(tradeId, msg.sender, buyer, amount, fee);
    }

    /// @notice Buyer marks fiat as sent (after this, refund is blocked).
    function confirmFiat(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "inactive");
        require(msg.sender == t.buyer, "not buyer");
        require(!t.fiatConfirmed, "already");

        t.fiatConfirmed = true;
        t.fiatConfirmedAt = block.timestamp;
        emit FiatConfirmed(tradeId, msg.sender);
    }

    /// @notice Seller releases USDC: buyer gets `amount`, platform gets `fee`.
    function release(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "inactive");
        require(msg.sender == t.seller, "not seller");

        t.active = false;
        uint256 amount = t.amount;
        uint256 fee = t.fee;
        address buyer = t.buyer;

        require(usdc.transfer(buyer, amount), "buyer transfer failed");
        if (fee > 0) {
            require(usdc.transfer(platform, fee), "fee transfer failed");
        }
        emit Released(tradeId, msg.sender, buyer, amount, fee);
    }

    /// @notice Seller refunds (only before fiat confirmed). Returns full deposit.
    function refund(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "inactive");
        require(msg.sender == t.seller, "not seller");
        require(!t.fiatConfirmed, "fiat confirmed");

        t.active = false;
        uint256 total = t.amount + t.fee;
        require(usdc.transfer(t.seller, total), "refund failed");
        emit Refunded(tradeId, msg.sender, total);
    }

    /// @notice Buyer reclaim if fiat was confirmed but seller never released.
    function claimByBuyer(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "inactive");
        require(msg.sender == t.buyer, "not buyer");
        require(t.fiatConfirmed, "fiat not confirmed");
        require(block.timestamp >= t.fiatConfirmedAt + AUTO_RELEASE_TIMEOUT, "timeout");

        t.active = false;
        uint256 amount = t.amount;
        uint256 fee = t.fee;
        address buyer = t.buyer;

        require(usdc.transfer(buyer, amount), "buyer transfer failed");
        if (fee > 0) {
            require(usdc.transfer(platform, fee), "fee transfer failed");
        }
        emit BuyerClaimed(tradeId, msg.sender, amount);
    }
}
