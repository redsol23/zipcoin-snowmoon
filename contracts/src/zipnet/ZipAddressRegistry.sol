// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ZipAddressRegistry
 * @notice Maps a wallet (and so its ENS name) to a public encryption key, so anyone can rezip coins to it privately:
 *         senders encrypt the new note's secrets to this key and recipients scan for what they can decrypt.
 * @dev The key is an X25519 public key derived in the browser from the same wallet signature as the zip key. It is
 *      never the key that spends notes. No owner; each wallet manages its own entry.
 */
contract ZipAddressRegistry {
  mapping(address => bytes32) public keyOf;

  event KeySet(address indexed account, bytes32 key);

  function setKey(bytes32 _key) external {
    keyOf[msg.sender] = _key;
    emit KeySet(msg.sender, _key);
  }
}
