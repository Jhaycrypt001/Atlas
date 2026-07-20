// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal non-custodial escrow. The agent orchestrates but never
/// custodies user funds — the contract holds them and enforces the rules:
///   - funds are pulled from `funder` (whoever supplies the money) into escrow;
///   - `release()` may only be triggered by the agent, and pays the payee the
///     amount minus a fee, with the fee going to the treasury;
///   - `refund()` returns the funds to the ORIGINAL funder, not to the agent.
/// A compromised agent key can move funds only along these fixed rails; it
/// cannot redirect the payee, the funder, or the amounts.
contract Escrow {
    address public immutable agent;    // may trigger release/refund; never a fund recipient
    address public immutable funder;   // supplies the escrowed funds; receives refunds
    address public payee;
    address public token;
    uint256 public amount;
    uint256 public feeBps;
    address public treasury;
    bool public released;

    constructor(
        address _funder,
        address _payee,
        address _token,
        uint256 _amount,
        uint256 _feeBps,
        address _treasury
    ) {
        require(_feeBps <= 10000, "fee > 100%");
        agent = msg.sender;
        funder = _funder;
        payee = _payee;
        token = _token;
        amount = _amount;
        feeBps = _feeBps;
        treasury = _treasury;
    }

    /// Pull the escrow amount from the funder. The funder must have approved
    /// this contract for `amount` beforehand.
    function lock() external {
        require(!released, "released");
        require(IERC20(token).transferFrom(funder, address(this), amount), "lock: transferFrom failed");
    }

    /// Release escrowed funds to the payee (minus fee) and the fee to treasury.
    /// Gated to the agent — this is the proof-verified settlement trigger.
    function release() external {
        require(msg.sender == agent, "only agent");
        require(!released, "released");
        released = true;
        uint256 fee = (amount * feeBps) / 10000;
        require(IERC20(token).transfer(payee, amount - fee), "release: payee transfer failed");
        require(IERC20(token).transfer(treasury, fee), "release: fee transfer failed");
    }

    /// Return escrowed funds to the original funder (dispute / abort path).
    function refund() external {
        require(msg.sender == agent, "only agent");
        require(!released, "released");
        released = true;
        require(IERC20(token).transfer(funder, amount), "refund: transfer failed");
    }
}
