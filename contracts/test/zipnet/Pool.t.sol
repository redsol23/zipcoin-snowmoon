// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';

import {ZipnetBase} from './ZipnetBase.sol';

/// @notice Sanity: the local stack, the mirrored trees and the off-chain prover agree with the on-chain verifier.
contract PoolTest is ZipnetBase {
  function test_zipThenRelayedUnzip() public {
    Note memory _n = _zip(makeAddr('alice'), 100 ether);
    address _bob = makeAddr('bob');
    address _relayer = makeAddr('relayer');

    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _bob, feeRecipient: _relayer, relayFeeBPS: 100}))
    );
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 40 ether, _w);

    entrypoint.relay(_w, _p, scope);
    _spent(_p);

    assertEq(zc.balanceOf(_bob), 39.6 ether);
    assertEq(zc.balanceOf(_relayer), 0.4 ether);
    assertEq(zc.balanceOf(address(pool)), 60 ether);
  }
}
