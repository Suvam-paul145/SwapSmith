// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RewardToken (SMTH)
 * @notice SwapSmith ERC20 reward token.
 *         Users earn points on the SwapSmith rewards page; the backend
 *         (owner wallet) calls rewardUser() to convert those points into
 *         on-chain SMTH tokens.
 *
 * Deployed on Sepolia testnet (free / no mainnet usage).
 */
contract RewardToken is ERC20, Ownable {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// @notice Initial supply minted to the deployer so it can fund rewards.
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 18;

    /// @notice Default maximum total supply (minting cap).
    uint256 public constant DEFAULT_MAX_SUPPLY = 10_000_000 * 10 ** 18;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// @notice Current minting cap — total supply can never exceed this.
    uint256 public mintingCap;

    /// @notice Pending new owner for two-step ownership transfer.
    address public pendingOwner;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted whenever the owner rewards a user with tokens.
    event UserRewarded(address indexed user, uint256 amount);

    /// @notice Emitted when the minting cap is updated by the owner.
    event MintingCapUpdated(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when a new owner is proposed via two-step transfer.
    event OwnershipTransferProposed(address indexed currentOwner, address indexed proposedOwner);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param initialOwner  Address that will own the contract (deployer).
     *                      Receives the full initial supply.
     */
    constructor(address initialOwner)
        ERC20("SwapSmith", "SMTH")
        Ownable(initialOwner)
    {
        mintingCap = DEFAULT_MAX_SUPPLY;

        // Mint 1,000,000 SMTH to the deployer / owner wallet.
        // This treasury is used to fund user rewards.
        _mint(initialOwner, INITIAL_SUPPLY);
    }

    // -----------------------------------------------------------------------
    // Owner functions
    // -----------------------------------------------------------------------

    /**
     * @notice Transfer reward tokens to a user.
     * @dev    Only callable by the contract owner (SwapSmith backend wallet).
     *         The owner must hold enough SMTH to cover the reward.
     * @param user    Recipient address (user's connected wallet).
     * @param amount  Token amount in wei (e.g. 10 * 10**18 for 10 SMTH).
     */
    function rewardUser(address user, uint256 amount) external onlyOwner {
        require(user != address(0), "RewardToken: reward to zero address");
        require(amount > 0, "RewardToken: amount must be > 0");
        require(
            balanceOf(owner()) >= amount,
            "RewardToken: insufficient owner balance"
        );

        _transfer(owner(), user, amount);
        emit UserRewarded(user, amount);
    }

    // -----------------------------------------------------------------------
    // Minting with cap enforcement
    // -----------------------------------------------------------------------

    /**
     * @notice Mint additional SMTH tokens to the owner treasury.
     * @dev    Only callable by the owner. Enforces the minting cap to
     *         prevent unbounded inflation.
     * @param amount Amount to mint (in wei).
     */
    function mintToTreasury(uint256 amount) external onlyOwner {
        require(amount > 0, "RewardToken: amount must be > 0");
        require(
            totalSupply() + amount <= mintingCap,
            "RewardToken: minting would exceed cap"
        );
        _mint(owner(), amount);
    }

    /**
     * @notice Update the minting cap. New cap must be >= current total supply.
     * @dev    Only callable by the owner.
     * @param newCap The new maximum total supply.
     */
    function setMintingCap(uint256 newCap) external onlyOwner {
        require(newCap >= totalSupply(), "RewardToken: cap below current supply");
        uint256 oldCap = mintingCap;
        mintingCap = newCap;
        emit MintingCapUpdated(oldCap, newCap);
    }

    // -----------------------------------------------------------------------
    // Two-step ownership transfer (access control upgrade path)
    // -----------------------------------------------------------------------

    /**
     * @notice Propose a new owner. The new owner must call acceptOwnership().
     * @dev    Overrides Ownable.transferOwnership to implement two-step transfer.
     * @param newOwner The proposed new owner address.
     */
    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "RewardToken: new owner is zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner(), newOwner);
    }

    /**
     * @notice Accept ownership after being proposed by the current owner.
     * @dev    Only callable by the pending owner.
     */
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "RewardToken: caller is not pending owner");
        pendingOwner = address(0);
        _transferOwnership(msg.sender);
    }
}
