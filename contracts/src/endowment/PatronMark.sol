// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface IEndowmentRegistry {
    function isEndowment(address endowment) external view returns (bool);
}

/// One mark per patron per endowment, minted by the endowment when a patron's gifts first reach
/// a dollar. Marks cannot be transferred (ERC-5192): they record who gave, so they stay with them.
contract PatronMark is ERC721 {
    struct Mark {
        address endowment;
        address patron;
        uint64 at;
        bool founding;
    }

    IEndowmentRegistry public immutable factory;
    string private _base;
    uint256 public total;
    mapping(uint256 => Mark) private _marks;

    /// ERC-5192: emitted once per mark, since a mark is locked from the start.
    event Locked(uint256 tokenId);

    error NotEndowment();
    error Soulbound();

    constructor(address factory_, string memory baseURI) ERC721("Bursar Patron", "PATRON") {
        factory = IEndowmentRegistry(factory_);
        _base = baseURI;
    }

    function mint(address patron, bool founding) external returns (uint256 tokenId) {
        if (!factory.isEndowment(msg.sender)) revert NotEndowment();
        tokenId = ++total;
        _marks[tokenId] = Mark({endowment: msg.sender, patron: patron, at: uint64(block.timestamp), founding: founding});
        _mint(patron, tokenId);
        emit Locked(tokenId);
    }

    function markOf(uint256 tokenId) external view returns (Mark memory) {
        _requireOwned(tokenId);
        return _marks[tokenId];
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId);
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) revert Soulbound();
    }
}
