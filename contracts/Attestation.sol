// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal on-chain attestation registry. Records that an obligation
/// was fulfilled, verifiable forever on X Layer. The agent writes here as the
/// final, auditable proof of completion.
contract Attestation {
    struct Att {
        address attestor;
        address about;
        bytes32 proofHash;
        uint256 ts;
    }

    Att[] public attestations;
    event Attested(uint256 id, address indexed attestor, address indexed about, bytes32 proofHash);

    function attest(address about, bytes32 proofHash) external returns (uint256) {
        attestations.push(Att({ attestor: msg.sender, about: about, proofHash: proofHash, ts: block.timestamp }));
        emit Attested(attestations.length - 1, msg.sender, about, proofHash);
        return attestations.length - 1;
    }

    function count() external view returns (uint256) {
        return attestations.length;
    }
}
