// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from '@oz/utils/ReentrancyGuardTransient.sol';

/// @notice The ETH holder-reward surface of the ZC token (LaunchToken)
interface IZcRewards {
  /// @notice ETH `holder` could claim right now
  function pendingReward(address holder) external view returns (uint256);
  /// @notice Settles and pays msg.sender its ETH; reverts NothingToClaim() when there is none
  function claim() external returns (uint256);
}

/**
 * @title ZcRewardsHarvester
 * @notice Shared base for contracts that hold ZC on behalf of stakers. ZC pays its holders rewards in ETH, and a
 *         contract holding staked ZC is the holder, so without this the ETH earned by staked ZC would be stranded.
 *
 * - `harvest()` (permissionless) claims the contract's ETH from ZC and books it into `accEthPerStake`.
 * - Stakers earn pro rata by earning stake over time: the inheriting contract reports every change to a staker's
 *   earning stake through `_setEthStake`, which first harvests (so ETH that accrued before the change goes to the
 *   stakers who held the stake while it accrued) and settles the staker.
 * - `pendingEth(account)` / `claimEth()` / `claimEthFor(account)` pay it out.
 *
 * Rules the inheriting contract follows: call `_setEthStake` whenever ZC starts or stops earning for someone (stake,
 * unstake, slash). Stake removed by a slash stops earning at the slash. ZC the contract holds that is not reported
 * as earning stake (e.g. fee reserves) still earns ETH at the token, and that ETH goes to the earning stakers.
 *
 * ETH that arrives while nobody is earning (R2-L4) was earned by ZC that nobody staked for (non-earning locks, parked
 * payouts, reserves, donations), so no staker has a claim to it. Giving it to whoever stakes next would be a windfall
 * for that staker. It is set aside as `unearnedEth` instead, and `sweepUnearnedEth()` (permissionless) sends it to
 * `_unearnedEthTo()`, the same treasury that escrow harvests pay. An inheriting contract that returns address(0) there
 * (one with no treasury) keeps it set aside and books it to the stakers at the first harvest after some exist.
 *
 * @dev Standard reward-per-token accumulator scaled by 1e36. `_ethReserve` is the ETH booked to stakers and not yet
 *      paid, and `unearnedEth` the ETH set aside while nobody was earning; anything the contract holds above both is
 *      new and is booked on the next harvest. Each staker is settled as floor(stake * (acc - accAtLastSettle) / 1e36),
 *      never above its exact share, so the payouts can never exceed the booked ETH; what rounds away stays as dust of
 *      a few wei. A payout is also capped at the reserve. Payouts follow checks-effects-interactions under a
 *      (transient) reentrancy guard, and stake changes refuse to run inside a payout.
 */
abstract contract ZcRewardsHarvester is ReentrancyGuardTransient {
  uint256 private constant ACC = 1e36;

  /// @notice The ZC token; the only address ETH is accepted from
  IZcRewards public immutable ZC_REWARDS;

  /// @notice Cumulative ETH per unit of earning stake, scaled by 1e36
  uint256 public accEthPerStake;
  /// @notice Sum of all earning stake
  uint256 public totalEthStake;
  /// @notice Each staker's earning stake
  mapping(address => uint256) public ethStakeOf;
  /// @notice ETH settled to a staker and not yet claimed
  mapping(address => uint256) public ethOwed;
  /// @notice ETH that arrived while nobody was earning; `sweepUnearnedEth` sends it to the treasury
  uint256 public unearnedEth;
  /// @dev accEthPerStake when the staker was last settled
  mapping(address => uint256) private _accAt;
  /// @dev ETH booked to stakers and not yet paid out
  uint256 private _ethReserve;

  event EthHarvested(uint256 claimed, uint256 booked, uint256 accEthPerStake);
  event EthClaimed(address indexed account, uint256 amount);
  /// @notice A staker's earning stake changed (so `ethStakeOf` can be rebuilt from logs)
  event EthStakeSet(address indexed account, uint256 stake, uint256 totalStake);
  /// @notice ETH arrived while nobody was earning and was set aside
  event EthUnearned(uint256 amount, uint256 unearnedEth);
  /// @notice Set-aside ETH went to the treasury
  event UnearnedEthSwept(address indexed to, uint256 amount);

  error OnlyZc();
  error EthTransferFailed();
  error StakeChangeDuringPayout();
  error NoUnearnedEth();

  constructor(address _zc) {
    ZC_REWARDS = IZcRewards(_zc);
  }

  /// @notice ETH arrives only from the ZC token's claim()
  receive() external payable {
    if (msg.sender != address(ZC_REWARDS)) revert OnlyZc();
  }

  /**
   * @notice Claims this contract's ETH rewards from ZC and books them to the stakers. Anyone may call it.
   * @dev Reverts with ZC's NothingToClaim() when there is nothing to claim, so callers can skip the transaction.
   */
  function harvest() external nonReentrant returns (uint256 _claimed) {
    _claimed = ZC_REWARDS.claim();
    _book(_claimed);
  }

  /**
   * @notice Sends the ETH set aside while nobody was earning to the treasury. Anyone may call it.
   * @dev Reverts NoUnearnedEth() when there is none, or when this contract has no treasury (it is then booked to the
   *      stakers once some exist).
   */
  function sweepUnearnedEth() external nonReentrant returns (uint256 _amount) {
    _harvestIfAny();
    address payable _to = _unearnedEthTo();
    _amount = unearnedEth;
    if (_amount == 0 || _to == address(0)) revert NoUnearnedEth();
    unearnedEth = 0;
    (bool _ok,) = _to.call{value: _amount}('');
    if (!_ok) revert EthTransferFailed();
    emit UnearnedEthSwept(_to, _amount);
  }

  /// @notice ETH `_account` can claim, including ETH the token holds for this contract but not yet harvested
  function pendingEth(address _account) external view returns (uint256) {
    uint256 _acc = accEthPerStake;
    if (totalEthStake != 0) {
      uint256 _unbooked = address(this).balance - _ethReserve - unearnedEth;
      if (_unearnedEthTo() == address(0)) _unbooked += unearnedEth;
      try ZC_REWARDS.pendingReward(address(this)) returns (uint256 _p) {
        _unbooked += _p;
      } catch {}
      _acc += (_unbooked * ACC) / totalEthStake;
    }
    return ethOwed[_account] + (ethStakeOf[_account] * (_acc - _accAt[_account])) / ACC;
  }

  /// @notice Pays msg.sender its ETH rewards
  function claimEth() external returns (uint256) {
    return _claimEth(msg.sender);
  }

  /// @notice Pays `_account` its ETH rewards (to `_account` only), so an account without gas can be paid out
  function claimEthFor(address _account) external returns (uint256) {
    return _claimEth(_account);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // for the inheriting contract
  // ---------------------------------------------------------------------------------------------------------------

  /// @dev Where ETH earned while nobody was earning goes (the pool's TREASURY); address(0) books it to later stakers
  function _unearnedEthTo() internal view virtual returns (address payable);

  /// @dev A privacy pool's TREASURY (ZipPrivacyPool), or address(0) for a pool without one
  function _poolTreasury(address _pool) internal view returns (address payable) {
    (bool _ok, bytes memory _r) = _pool.staticcall(abi.encodeWithSignature('TREASURY()'));
    return _ok && _r.length >= 32 ? payable(abi.decode(_r, (address))) : payable(address(0));
  }

  /// @dev Sets `_account`'s earning stake. Harvests first, so earlier ETH goes to the earlier stake.
  function _setEthStake(address _account, uint256 _stake) internal {
    if (_reentrancyGuardEntered()) revert StakeChangeDuringPayout();
    _harvestIfAny();
    uint256 _acc = accEthPerStake;
    uint256 _old = ethStakeOf[_account];
    ethOwed[_account] += (_old * (_acc - _accAt[_account])) / ACC;
    _accAt[_account] = _acc;
    ethStakeOf[_account] = _stake;
    uint256 _total = totalEthStake - _old + _stake;
    totalEthStake = _total;
    emit EthStakeSet(_account, _stake, _total);
  }

  function _addEthStake(address _account, uint256 _amount) internal {
    _setEthStake(_account, ethStakeOf[_account] + _amount);
  }

  function _subEthStake(address _account, uint256 _amount) internal {
    _setEthStake(_account, ethStakeOf[_account] - _amount);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @dev Claims only when the token reports something to claim, so stake changes never hit NothingToClaim(). A
   *      token without the reward interface (e.g. a local stand-in) is skipped rather than blocking stake changes.
   *      The claim itself is not wrapped in try/catch, so it cannot be skipped by starving it of gas.
   */
  function _harvestIfAny() private {
    uint256 _claimed;
    try ZC_REWARDS.pendingReward(address(this)) returns (uint256 _p) {
      if (_p != 0) _claimed = ZC_REWARDS.claim();
    } catch {}
    _book(_claimed);
  }

  /**
   * @dev Books every unbooked wei (the claim plus anything else that arrived) to the current earning stake. With
   *      nobody earning it is set aside instead (R2-L4). Without a treasury, set-aside ETH is booked with the next
   *      ETH that finds stakers.
   */
  function _book(uint256 _claimed) private {
    uint256 _new = address(this).balance - _ethReserve - unearnedEth;
    uint256 _total = totalEthStake;
    if (_total == 0) {
      if (_new != 0) {
        unearnedEth += _new;
        emit EthUnearned(_new, unearnedEth);
      }
      return;
    }
    if (unearnedEth != 0 && _unearnedEthTo() == address(0)) {
      _new += unearnedEth;
      unearnedEth = 0;
    }
    if (_new == 0) return;
    _ethReserve += _new;
    accEthPerStake += (_new * ACC) / _total;
    emit EthHarvested(_claimed, _new, accEthPerStake);
  }

  function _claimEth(address _account) private nonReentrant returns (uint256 _amount) {
    _harvestIfAny();
    uint256 _acc = accEthPerStake;
    _amount = ethOwed[_account] + (ethStakeOf[_account] * (_acc - _accAt[_account])) / ACC;
    ethOwed[_account] = 0;
    _accAt[_account] = _acc;
    if (_amount > _ethReserve) _amount = _ethReserve; // belt and braces: never pay out unbooked ETH
    _ethReserve -= _amount;
    if (_amount != 0) {
      (bool _ok,) = _account.call{value: _amount}('');
      if (!_ok) revert EthTransferFailed();
    }
    emit EthClaimed(_account, _amount);
  }
}
