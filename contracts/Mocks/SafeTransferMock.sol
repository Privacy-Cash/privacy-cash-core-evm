// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Exposes both the safe (assembly) and unsafe (Solidity .call) ETH transfer
///      patterns so tests can compare gas behaviour against returnbomb contracts.
contract SafeTransferMock {

    /// @dev Assembly call – zero-length return buffer, immune to returnbomb.
    function safeTransferETH(address recipient, uint256 amount) external {
        bool success;
        assembly {
            success := call(gas(), recipient, amount, 0, 0, 0, 0)
        }
        require(success, "ETH transfer failed");
    }

    /// @dev Solidity .call – copies return data into memory, vulnerable to returnbomb.
    function unsafeTransferETH(address recipient, uint256 amount) external {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
