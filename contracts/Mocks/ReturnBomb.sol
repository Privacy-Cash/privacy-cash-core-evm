// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Returns a configurable-size payload from receive(), used to test returnbomb resistance.
contract ReturnBomb {
    uint256 public bombSize;

    constructor(uint256 _bombSize) {
        bombSize = _bombSize;
    }

    receive() external payable {
        uint256 size = bombSize;
        assembly {
            revert(0, size)
        }
    }
}

/// @dev Same as ReturnBomb but returns data instead of reverting, so the call succeeds.
contract ReturnBombSuccess {
    uint256 public bombSize;

    constructor(uint256 _bombSize) {
        bombSize = _bombSize;
    }

    receive() external payable {
        uint256 size = bombSize;
        assembly {
            return(0, size)
        }
    }
}
