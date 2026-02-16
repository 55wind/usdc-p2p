// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract USDCEscrow {
    IERC20 public immutable usdc;

    struct Trade {
        address seller;
        address buyer;
        uint256 amount;
        bool active;
    }

    mapping(bytes32 => Trade) public trades;

    event Deposited(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount);
    event Released(bytes32 indexed tradeId, address indexed seller, address indexed buyer, uint256 amount);
    event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function deposit(bytes32 tradeId, address buyer, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(buyer != address(0), "Invalid buyer");
        require(!trades[tradeId].active, "Trade already exists");

        trades[tradeId] = Trade({
            seller: msg.sender,
            buyer: buyer,
            amount: amount,
            active: true
        });

        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        emit Deposited(tradeId, msg.sender, buyer, amount);
    }

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

    function refund(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];
        require(t.active, "Trade not active");
        require(msg.sender == t.seller, "Only seller");

        t.active = false;
        uint256 amount = t.amount;

        require(usdc.transfer(t.seller, amount), "Transfer failed");

        emit Refunded(tradeId, msg.sender, amount);
    }
}
