// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';
import {ReentrancyGuardTransient} from '@oz/utils/ReentrancyGuardTransient.sol';

/// @notice The Uniswap v4 PositionManager functions this contract uses
interface IBandsPositionManager {
  function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
  function nextTokenId() external view returns (uint256);
  function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
  function poolManager() external view returns (address);
  function permit2() external view returns (address);
  function transferFrom(address from, address to, uint256 id) external;
}

/// @notice Permit2's allowance setter (the PositionManager pulls ERC-20s through Permit2)
interface IBandsPermit2 {
  function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice The v4 PoolManager's raw storage read (slot0 lives in `pools[poolId]`)
interface IBandsPoolManager {
  function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice ZC's ETH holder rewards
interface IBandsZcRewards {
  function claim() external returns (uint256);
}

/**
 * @title ZipLiquidityBands
 * @notice Places the treasury's share of the sales tax (ZC) as one-sided Uniswap v4 liquidity in ZC's ETH/ZC pool, in
 *         three fixed price bands that all lie ABOVE the locked launch position (beyond the price at which it has sold
 *         all its ZC). It never adds liquidity at or below the launch range, and never puts ETH into liquidity: ETH that
 *         reaches it is passed on to the treasury Safe. Every output goes to one immutable address, the Safe.
 *
 * The pool: currency0 = native ETH, currency1 = ZC, fee 1% (10000), tickSpacing 200, ZC's launch hook. The price is
 * ZC per ETH, so the tick goes DOWN as ZC gets more expensive. The launch position is locked forever at ticks
 * [127,600, 196,600]: fully diluted value (FDV, 1e9 ZC) from about 2.9 ETH (tick 196,600, the launch price) up to
 * about 2,875 ETH (tick 127,600, where it has sold all its ZC). The bands continue above that sell-out point only:
 *
 *   band  asset     ticks                 FDV in ETH             default split
 *   U1    ZC only   [115,200, 127,600]    ~2,875  to ~9,935      70% of ZC
 *   U2    ZC only   [ 92,200, 115,200]    ~9,935  to ~99,000     20% of ZC
 *   U3    ZC only   [-887,200, 92,200]    ~99,000 and up         10% of ZC
 *
 * (Edges are multiples of 200; -887,200 is the widest usable tick at spacing 200; 12,400 ticks is a factor of
 * e^1.24 ≈ 3.46 and 23,000 ticks a factor of e^2.3 ≈ 10.) Every band's upper tick is <= LAUNCH_LOWER, so nothing is
 * ever placed below the launch position's sell-out point; the owner's decision is that the treasury does not cover
 * the market below the range the launch position covers.
 *
 * Why this cannot be manipulated, and needs no price oracle:
 * - A band is only ever added to while the price is entirely below it (tick >= its upper tick), so the band takes
 *   exactly one asset, ZC. The amount it takes for a given liquidity depends only on the band's ticks, not on the
 *   price. The price is read only to decide whether to SKIP a band, never to size a deposit.
 * - The ETH maximum is always 0 and no ETH is ever sent with a call. If the price were inside the band, the
 *   PositionManager would revert with MaximumAmountExceeded rather than take ETH.
 * - A band the price has entered (or passed) is skipped and its share falls through to the next band further out
 *   (U1 -> U2 -> U3). If none is left, the ZC waits here. There is no swap and no ratio to skew, so there is nothing
 *   to sandwich.
 * - Bands never overlap the launch range, so they never take a share of the fees that pay ZC holders.
 *
 * Who can do what:
 * - Anyone: `deposit()` (ZC, within the caps and `minInterval`), `collect(band)` (fees to the Safe), `claimRewards()`
 *   (this contract's own ZC holder rewards, ETH, straight on to the Safe) and `forwardEth()` (all ETH here to the Safe).
 * - The Safe only: caps within an immutable ceiling, band weights, pause, `forwardAll`, and the exits `withdraw` /
 *   `withdrawAll` / `release` / `sweep`, all of which pay the Safe.
 * - No function sends assets or position NFTs anywhere except the Safe, the PositionManager and (through Permit2)
 *   the PoolManager. There are no arbitrary calls, no delegatecall and no upgrade path. Position NFTs stay here
 *   until the Safe calls `release`.
 *
 * Money in: ZC by plain transfer (ZipPay's treasury share is sent here). ETH from anyone (ZC rewards, the privacy
 * pool's and the escrow contracts' harvests): it is never used for liquidity; `forwardEth()` (and `claimRewards()`)
 * pass all of it to the Safe.
 *
 * Fees are never compounded: `collect`, and every top-up (which must flush fees first so the add settles cleanly),
 * send them to the Safe. Liquidity is never removed or moved automatically.
 */
contract ZipLiquidityBands is ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  /// @notice Deposit limits the Safe sets within the immutable ceiling. Amounts in wei.
  struct Caps {
    uint128 perCallZc;
    /// @dev per 24h window
    uint128 dayZc;
    /// @dev ZC is only deposited when at least this much is available
    uint128 minZc;
    /// @dev seconds between deposits
    uint32 minInterval;
  }

  /// @notice What each band has done, cumulative
  struct Band {
    uint256 tokenId;
    uint128 zcIn;
    uint128 feesEth;
    uint128 feesZc;
  }

  /// @dev v4 pool key; Currency and IHooks encode as addresses
  struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
  }

  enum Skip {
    InRange,
    TooSmall
  }

  uint256 public constant BANDS = 3;
  uint8 public constant U1 = 0;
  uint8 public constant U2 = 1;
  uint8 public constant U3 = 2;
  uint24 public constant FEE = 10_000;
  int24 public constant TICK_SPACING = 200;
  /// @notice The locked launch position's range. Every band lies entirely above it (upper tick <= LAUNCH_LOWER).
  int24 public constant LAUNCH_LOWER = 127_600;
  int24 public constant LAUNCH_UPPER = 196_600;
  /// @notice `minInterval` can never be set below this
  uint32 public constant MIN_INTERVAL_FLOOR = 1 hours;

  // v4-periphery Actions
  uint8 private constant INCREASE_LIQUIDITY = 0x00;
  uint8 private constant DECREASE_LIQUIDITY = 0x01;
  uint8 private constant MINT_POSITION = 0x02;
  uint8 private constant SETTLE_PAIR = 0x0d;
  uint8 private constant TAKE_PAIR = 0x11;
  /// @dev v4 PoolManager: `mapping(PoolId => Pool.State) pools` is at slot 6; slot0 is the first word of the state
  uint256 private constant POOLS_SLOT = 6;
  uint256 private constant Q96 = 2 ** 96;
  // TickMath.getSqrtPriceAtTick at the band edges
  uint256 private constant SQRT_M887200 = 4_310_618_292;
  uint256 private constant SQRT_92200 = 7_959_339_820_541_314_895_926_346_603_111;
  uint256 private constant SQRT_115200 = 25_135_685_339_936_509_999_814_510_248_241;
  uint256 private constant SQRT_127600 = 46_723_981_960_100_762_045_660_812_846_120;
  uint256 private constant BPS = 10_000;

  /// @notice The treasury Safe: owner, and the only recipient of anything that leaves
  address public immutable SAFE;
  IERC20 public immutable ZC;
  IBandsPositionManager public immutable POSM;
  IBandsPermit2 public immutable PERMIT2;
  IBandsPoolManager public immutable POOL_MANAGER;
  address public immutable HOOKS;
  bytes32 public immutable POOL_ID;
  /// @notice The privacy pool whose harvest pays this contract (zero = none). Informational since R2-M1 (ETH is
  ///         accepted from anyone); the deploy script and `check()` use it to assert the harvest wiring.
  address public immutable HARVEST_SOURCE;
  /// @notice Hard ceiling on the Safe's day cap
  uint128 public immutable MAX_DAY_ZC;

  Caps public caps;
  /// @notice Share of each ZC deposit per band, in bps. U1..U3 sum to 10000 (or 0: ZC waits).
  uint16[3] public weights;
  Band[3] public bands;
  bool public paused;
  /// @notice When set, deposit() and claimRewards() send everything here to the Safe instead of adding liquidity
  bool public forwardAll;
  uint64 public lastDeposit;
  uint64 public windowStart;
  uint128 public usedZc;

  event Deposited(uint8 indexed band, uint256 indexed tokenId, uint128 liquidity, uint256 zcIn, address caller);
  event Skipped(uint8 indexed band, Skip reason, uint256 amount);
  event FeesCollected(uint8 indexed band, uint256 eth, uint256 zc);
  event Withdrawn(uint8 indexed band, uint128 liquidity, uint256 eth, uint256 zc);
  event Released(uint8 indexed band, uint256 tokenId);
  event RewardsClaimed(uint256 eth);
  /// @notice ETH passed on to the Safe by forwardEth() / claimRewards()
  event EthToSafe(uint256 eth);
  event Swept(address indexed token, uint256 amount);
  event Forwarded(uint256 zc, uint256 eth);
  event CapsSet(Caps caps);
  event WeightsSet(uint16[3] weights);
  event Paused(bool paused);
  event ForwardAll(bool on);
  /// @notice ETH that arrived (it waits for forwardEth(), which sends it to the Safe)
  event EthReceived(address indexed from, uint256 amount);

  error OnlySafe();
  error IsPaused();
  error TooSoon();
  error NothingToDeposit();
  error NoPosition();
  error BadBand();
  error BadCaps();
  error BadWeights();
  error BadConfig();
  error PoolNotInitialized();
  error EthTransferFailed();

  modifier onlySafe() {
    if (msg.sender != SAFE) revert OnlySafe();
    _;
  }

  /**
   * @param _safe the treasury Safe
   * @param _zc the ZC token (currency1; must sort above native ETH, which every nonzero address does)
   * @param _posm the Uniswap v4 PositionManager; its PoolManager and Permit2 are read from it
   * @param _hooks the pool's hook (ZC's launch guard)
   * @param _harvestSource the privacy pool if its harvest pays this contract, else zero
   * @param _maxDayZc immutable ceiling on `caps.dayZc`
   */
  constructor(
    address _safe,
    address _zc,
    address _posm,
    address _hooks,
    address _harvestSource,
    uint128 _maxDayZc,
    Caps memory _caps,
    uint16[3] memory _weights
  ) {
    if (_safe == address(0) || _zc == address(0) || _posm.code.length == 0) revert BadConfig();
    SAFE = _safe;
    ZC = IERC20(_zc);
    POSM = IBandsPositionManager(_posm);
    PERMIT2 = IBandsPermit2(POSM.permit2());
    POOL_MANAGER = IBandsPoolManager(POSM.poolManager());
    HOOKS = _hooks;
    HARVEST_SOURCE = _harvestSource;
    MAX_DAY_ZC = _maxDayZc;
    POOL_ID = keccak256(abi.encode(_key()));
    (uint160 _sqrtP,) = _slot0();
    if (_sqrtP == 0) revert PoolNotInitialized();
    _setCaps(_caps);
    _setWeights(_weights);
  }

  /**
   * @notice ETH is accepted from anyone (ZC rewards, the privacy pool's and the escrow contracts' harvests, R2-M1) and
   *         only ever leaves to the Safe, so a sender can only donate. It is never put into liquidity: it waits here
   *         (so a gas-limited sender still succeeds) until anyone calls `forwardEth()`.
   */
  receive() external payable {
    emit EthReceived(msg.sender, msg.value);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // permissionless
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @notice Adds this contract's ZC to the U bands, one-sided, skipping any band the price is in. Anyone may call it;
   *         it only ever does this one thing. Reverts NothingToDeposit if nothing was added, so a caller can simulate
   *         first and skip.
   * @dev With `forwardAll` on it instead sends everything here to the Safe.
   */
  function deposit() external nonReentrant {
    if (forwardAll) {
      _forward();
      return;
    }
    if (paused) revert IsPaused();
    if (block.timestamp < uint256(lastDeposit) + caps.minInterval) revert TooSoon();
    _roll();
    uint256 _zc = _capped(ZC.balanceOf(address(this)), 0);
    (, int24 _tick) = _slot0();
    uint256 _used = _zc == 0 ? 0 : _deposit(_zc, _tick);
    if (_used == 0) revert NothingToDeposit();
    usedZc += uint128(_used);
    lastDeposit = uint64(block.timestamp);
  }

  /// @notice Sends all the ETH here to the Safe. Anyone may call it; works while paused. Returns what was sent.
  function forwardEth() external nonReentrant returns (uint256 _eth) {
    _eth = _ethToSafe();
  }

  /// @notice Sends a band's accrued fees (ETH and ZC) to the Safe. Anyone may call it.
  function collect(uint8 _band) external nonReentrant returns (uint256 _eth, uint256 _zc) {
    uint256 _id = _tokenId(_band);
    (_eth, _zc) = _decreaseToSafe(_id, 0, 0, 0);
    _bookFees(_band, _eth, _zc);
  }

  /**
   * @notice Claims this contract's ZC holder rewards (ETH, earned on ZC waiting here) and sends all the ETH here to
   *         the Safe (everything, ZC included, with `forwardAll`). Anyone may call it; reverts with ZC's
   *         NothingToClaim() when there is nothing.
   */
  function claimRewards() external nonReentrant returns (uint256 _claimed) {
    _claimed = IBandsZcRewards(address(ZC)).claim();
    emit RewardsClaimed(_claimed);
    if (forwardAll) _forward();
    else _ethToSafe();
  }

  /**
   * @notice The ZC deposit() would add right now, within the caps: 0 if below the minimum or if no band can take it at
   *         the current price. `ok` is false while paused, before `minInterval` has passed, or when there is nothing
   *         to add. With `forwardAll`, the ZC balance it would forward (and `ok` if there is any ZC or ETH).
   */
  function depositable() external view returns (uint256 _zc, bool _ok) {
    if (forwardAll) {
      _zc = ZC.balanceOf(address(this));
      return (_zc, _zc != 0 || address(this).balance != 0);
    }
    _zc = _capped(ZC.balanceOf(address(this)), _windowOpen() ? 0 : 1);
    (, int24 _tick) = _slot0();
    if (_zc != 0 && !_places(_zc, _tick)) _zc = 0;
    _ok = !paused && block.timestamp >= uint256(lastDeposit) + caps.minInterval && _zc != 0;
  }

  /// @notice A band's ticks
  function bandTicks(uint8 _band) public pure returns (int24 _lower, int24 _upper) {
    (_lower, _upper,,) = bandRange(_band);
  }

  /**
   * @notice A band's ticks and their sqrt prices (Q64.96). The sqrt prices are the exact values of Uniswap's
   *         TickMath.getSqrtPriceAtTick for these ticks, written out as constants (checked in the tests against an
   *         independent high-precision computation, and on a mainnet fork against the real PositionManager).
   */
  function bandRange(uint8 _band)
    public
    pure
    returns (int24 _lower, int24 _upper, uint256 _sqrtLower, uint256 _sqrtUpper)
  {
    if (_band == U1) return (115_200, 127_600, SQRT_115200, SQRT_127600);
    if (_band == U2) return (92_200, 115_200, SQRT_92200, SQRT_115200);
    if (_band == U3) return (-887_200, 92_200, SQRT_M887200, SQRT_92200);
    revert BadBand();
  }

  /**
   * @notice The liquidity `_amount` of ZC buys in a band, rounded down so the PositionManager's rounded-up cost of it
   *         never exceeds `_amount`. Depends only on the band's ticks.
   */
  function liquidityFor(uint8 _band, uint256 _amount) public pure returns (uint128) {
    (,, uint256 _sa, uint256 _sb) = bandRange(_band);
    uint256 _l = Math.mulDiv(_amount, Q96, _sb - _sa);
    return _l > type(uint128).max ? type(uint128).max : uint128(_l);
  }

  /// @notice Whether the price is entirely below a band (tick >= its upper tick), so it can take ZC only
  function outOfRange(uint8 _band) external view returns (bool) {
    (, int24 _tick) = _slot0();
    return _outOfRange(_band, _tick);
  }

  /// @notice The pool's current sqrt price and tick
  function slot0() external view returns (uint160 sqrtPriceX96, int24 tick) {
    return _slot0();
  }

  /// @notice The pool key (native ETH, ZC, 1%, spacing 200, ZC's hook)
  function poolKey() external view returns (PoolKey memory) {
    return _key();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the Safe
  // ---------------------------------------------------------------------------------------------------------------

  function setCaps(Caps calldata _caps) external onlySafe {
    _setCaps(_caps);
  }

  function setWeights(uint16[3] calldata _weights) external onlySafe {
    _setWeights(_weights);
  }

  /// @notice Stops deposit(). collect, claimRewards, forwardEth and the Safe's exits keep working.
  function pause() external onlySafe {
    paused = true;
    emit Paused(true);
  }

  function unpause() external onlySafe {
    paused = false;
    emit Paused(false);
  }

  /// @notice The escape hatch: from now on deposit() and claimRewards() pass everything here to the Safe
  function setForwardAll(bool _on) external onlySafe {
    forwardAll = _on;
    emit ForwardAll(_on);
  }

  /// @notice Removes liquidity from a band; principal and fees go to the Safe
  function withdraw(uint8 _band, uint128 _liquidity, uint128 _min0, uint128 _min1)
    external
    onlySafe
    nonReentrant
    returns (uint256 _eth, uint256 _zc)
  {
    (_eth, _zc) = _decreaseToSafe(_tokenId(_band), _liquidity, _min0, _min1);
    emit Withdrawn(_band, _liquidity, _eth, _zc);
  }

  /**
   * @notice Emergency exit: pauses, removes all liquidity from every band and sends it, and all idle ETH and ZC, to
   *         the Safe. Minimums are 0: bands are normally out of range, where the amounts cannot be moved by trading;
   *         for an in-range band the Safe can use withdraw() with minimums instead.
   */
  function withdrawAll() external onlySafe nonReentrant {
    paused = true;
    emit Paused(true);
    for (uint8 _b; _b < BANDS; ++_b) {
      uint256 _id = bands[_b].tokenId;
      if (_id == 0) continue;
      uint128 _l = POSM.getPositionLiquidity(_id);
      (uint256 _eth, uint256 _zc) = _decreaseToSafe(_id, _l, 0, 0);
      emit Withdrawn(_b, _l, _eth, _zc);
    }
    _forward();
  }

  /// @notice Hands a band's position NFT to the Safe; the next deposit into that band mints a new one
  function release(uint8 _band) external onlySafe nonReentrant {
    uint256 _id = _tokenId(_band);
    bands[_band].tokenId = 0;
    POSM.transferFrom(address(this), SAFE, _id);
    emit Released(_band, _id);
  }

  /// @notice Sends this contract's whole balance of `_token` (zero address = ETH) to the Safe
  function sweep(address _token) external onlySafe nonReentrant {
    uint256 _amount;
    if (_token == address(0)) {
      _amount = address(this).balance;
      _sendEth(_amount);
    } else {
      _amount = IERC20(_token).balanceOf(address(this));
      IERC20(_token).safeTransfer(SAFE, _amount);
    }
    emit Swept(_token, _amount);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @dev Deposits `_amount` ZC over U1..U3 by weight. A band the price is not entirely below is skipped and its share
   *      carried to the next band out. Rounding dust stays here. Returns what was actually added.
   */
  function _deposit(uint256 _amount, int24 _tick) internal returns (uint256 _used) {
    uint256 _carry;
    for (uint8 _b; _b < BANDS; ++_b) {
      uint256 _share = _carry + (_amount * weights[_b]) / BPS;
      if (_share == 0) continue;
      if (!_outOfRange(_b, _tick)) {
        emit Skipped(_b, Skip.InRange, _share);
        _carry = _share;
        continue;
      }
      uint256 _spent = _add(_b, _share);
      if (_spent == 0) emit Skipped(_b, Skip.TooSmall, _share);
      _carry = _spent == 0 ? _share : 0;
      _used += _spent;
    }
  }

  /// @dev One modifyLiquidities adding `_share` ZC (and 0 ETH, none sent) to the band
  function _add(uint8 _b, uint256 _share) internal returns (uint256 _spent) {
    uint128 _l = liquidityFor(_b, _share);
    if (_l == 0) return 0;

    uint256 _before = ZC.balanceOf(address(this));
    // Exact amount, expiring this block: the PositionManager can pull this much ZC, once, now
    ZC.forceApprove(address(PERMIT2), _share);
    PERMIT2.approve(address(ZC), address(POSM), uint160(_share), uint48(block.timestamp));
    uint256 _id = bands[_b].tokenId;
    bytes memory _data;
    if (_id == 0) {
      _id = POSM.nextTokenId();
      bands[_b].tokenId = _id;
      _data = _mintData(_b, _l, _share);
    } else {
      _data = _topUpData(_id, _l, _share);
    }

    (uint256 _safeEth, uint256 _safeZc) = (SAFE.balance, ZC.balanceOf(SAFE));
    POSM.modifyLiquidities(_data, block.timestamp);
    (_safeEth, _safeZc) = (SAFE.balance - _safeEth, ZC.balanceOf(SAFE) - _safeZc);
    if (_safeEth != 0 || _safeZc != 0) _bookFees(_b, _safeEth, _safeZc);

    uint256 _after = ZC.balanceOf(address(this));
    _spent = _before > _after ? _before - _after : 0;
    if (_spent > _share) _spent = _share;
    bands[_b].zcIn += uint128(_spent);
    emit Deposited(_b, _id, _l, _spent, msg.sender);
  }

  /// @dev MINT_POSITION (owner: this contract, ETH max 0) + SETTLE_PAIR
  function _mintData(uint8 _b, uint128 _l, uint256 _share) internal view returns (bytes memory) {
    (int24 _lo, int24 _hi) = bandTicks(_b);
    bytes[] memory _p = new bytes[](2);
    _p[0] = abi.encode(_key(), _lo, _hi, uint256(_l), uint128(0), uint128(_share), address(this), bytes(''));
    _p[1] = abi.encode(address(0), address(ZC));
    return abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), _p);
  }

  /**
   * @dev Fees first, to the Safe (DECREASE_LIQUIDITY 0 + TAKE_PAIR), because SETTLE_PAIR reverts if accrued fees leave
   *      a positive delta; then INCREASE_LIQUIDITY (ETH max 0) + SETTLE_PAIR
   */
  function _topUpData(uint256 _id, uint128 _l, uint256 _share) internal view returns (bytes memory) {
    bytes[] memory _p = new bytes[](4);
    _p[0] = abi.encode(_id, uint256(0), uint128(0), uint128(0), bytes(''));
    _p[1] = abi.encode(address(0), address(ZC), SAFE);
    _p[2] = abi.encode(_id, uint256(_l), uint128(0), uint128(_share), bytes(''));
    _p[3] = abi.encode(address(0), address(ZC));
    return abi.encode(abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR, INCREASE_LIQUIDITY, SETTLE_PAIR), _p);
  }

  /// @dev DECREASE_LIQUIDITY + TAKE_PAIR to the Safe; returns what the Safe received
  function _decreaseToSafe(uint256 _id, uint128 _liquidity, uint128 _min0, uint128 _min1)
    internal
    returns (uint256 _eth, uint256 _zc)
  {
    bytes[] memory _params = new bytes[](2);
    _params[0] = abi.encode(_id, uint256(_liquidity), _min0, _min1, bytes(''));
    _params[1] = abi.encode(address(0), address(ZC), SAFE);
    (uint256 _e, uint256 _z) = (SAFE.balance, ZC.balanceOf(SAFE));
    POSM.modifyLiquidities(abi.encode(abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR), _params), block.timestamp);
    (_eth, _zc) = (SAFE.balance - _e, ZC.balanceOf(SAFE) - _z);
  }

  function _bookFees(uint8 _b, uint256 _eth, uint256 _zc) internal {
    bands[_b].feesEth += uint128(_eth);
    bands[_b].feesZc += uint128(_zc);
    emit FeesCollected(_b, _eth, _zc);
  }

  /// @dev All the ETH here to the Safe
  function _ethToSafe() internal returns (uint256 _eth) {
    _eth = address(this).balance;
    if (_eth != 0) {
      _sendEth(_eth);
      emit EthToSafe(_eth);
    }
  }

  /// @dev Everything idle here to the Safe
  function _forward() internal {
    uint256 _zc = ZC.balanceOf(address(this));
    uint256 _eth = address(this).balance;
    if (_zc != 0) ZC.safeTransfer(SAFE, _zc);
    if (_eth != 0) _sendEth(_eth);
    emit Forwarded(_zc, _eth);
  }

  function _sendEth(uint256 _amount) internal {
    (bool _ok,) = SAFE.call{value: _amount}('');
    if (!_ok) revert EthTransferFailed();
  }

  /// @dev Starts a new 24h window once the last one has ended
  function _roll() internal {
    if (_windowOpen()) return;
    windowStart = uint64(block.timestamp);
    usedZc = 0;
  }

  function _windowOpen() internal view returns (bool) {
    return block.timestamp < uint256(windowStart) + 1 days;
  }

  /// @dev A ZC balance cut to the per-call cap and what is left of the day cap (`_fresh` = 1: a new window would start)
  function _capped(uint256 _zcBal, uint256 _fresh) internal view returns (uint256 _zc) {
    Caps memory _c = caps;
    uint256 _dayLeft = _c.dayZc - (_fresh == 1 ? 0 : Math.min(usedZc, _c.dayZc));
    _zc = Math.min(_zcBal, Math.min(_c.perCallZc, _dayLeft));
    if (_zc < _c.minZc) _zc = 0;
  }

  /// @dev Whether deposit() would place any of `_amount`: _deposit's walk, without the calls
  function _places(uint256 _amount, int24 _tick) internal view returns (bool) {
    uint256 _carry;
    for (uint8 _b; _b < BANDS; ++_b) {
      uint256 _share = _carry + (_amount * weights[_b]) / BPS;
      if (_share == 0) continue;
      if (_outOfRange(_b, _tick) && liquidityFor(_b, _share) != 0) return true;
      _carry = _share;
    }
    return false;
  }

  /// @dev A band takes only ZC while tick >= its upper tick (v4's own test: the price is entirely below the range)
  function _outOfRange(uint8 _b, int24 _tick) internal pure returns (bool) {
    (, int24 _hi) = bandTicks(_b);
    return _tick >= _hi;
  }

  function _tokenId(uint8 _band) internal view returns (uint256 _id) {
    if (_band >= BANDS) revert BadBand();
    _id = bands[_band].tokenId;
    if (_id == 0) revert NoPosition();
  }

  function _key() internal view returns (PoolKey memory) {
    return PoolKey(address(0), address(ZC), FEE, TICK_SPACING, HOOKS);
  }

  function _slot0() internal view returns (uint160 _sqrtP, int24 _tick) {
    bytes32 _slot = keccak256(abi.encode(POOL_ID, POOLS_SLOT));
    uint256 _d = uint256(POOL_MANAGER.extsload(_slot));
    _sqrtP = uint160(_d);
    _tick = int24(int256(_d >> 160));
  }

  function _setCaps(Caps memory _c) internal {
    if (_c.dayZc > MAX_DAY_ZC || _c.perCallZc > _c.dayZc || _c.minInterval < MIN_INTERVAL_FLOOR) revert BadCaps();
    caps = _c;
    emit CapsSet(_c);
  }

  function _setWeights(uint16[3] memory _w) internal {
    uint256 _u = uint256(_w[U1]) + _w[U2] + _w[U3];
    if (_u != 0 && _u != BPS) revert BadWeights();
    weights = _w;
    emit WeightsSet(_w);
  }
}
