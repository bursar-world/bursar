pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mux1.circom";

// Proves that one spend sits inside a committed mandate without revealing the mandate.
//
// The account stores two field elements and nothing else about the terms:
//   termsCommitment = Poseidon(perCallCap, periodCap, periodLen, totalCap, capabilityRoot,
//                              counterpartyRoot, expiry, salt)
//   counter         = Poseidon(period, spentInPeriod, totalSpent, salt, nonce)
//
// A proof moves the counter from `nonce` to `nonce + 1` and shows that the spend fits the
// per-call cap, the period cap, the lifetime total, the capability set, the counterparty set and
// the expiry. The account checks the public inputs against its own state before it pays, and
// hands the escrow the same capability id the proof was made for.
//
// A capability id is 32 bytes and a field element is not, so the id enters as two public 128-bit
// halves. Its leaf in the capability tree is Poseidon(hi, lo).

template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component muxes[depth];
    signal levels[depth + 1];
    levels[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxes[i] = MultiMux1(2);
        muxes[i].c[0][0] <== levels[i];
        muxes[i].c[0][1] <== pathElements[i];
        muxes[i].c[1][0] <== pathElements[i];
        muxes[i].c[1][1] <== levels[i];
        muxes[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxes[i].out[0];
        hashers[i].inputs[1] <== muxes[i].out[1];
        levels[i + 1] <== hashers[i].out;
    }

    root <== levels[depth];
}

template WithinMandate(counterpartyDepth, capabilityDepth) {
    // Public, in the order the verifier receives them.
    signal input mandate;
    signal input termsCommitment;
    signal input oldCounter;
    signal input newCounter;
    signal input nullifier;
    signal input amount;
    signal input payee;
    signal input capabilityHi;
    signal input capabilityLo;
    signal input now;
    signal input nonce;

    // Private terms.
    signal input perCallCap;
    signal input periodCap;
    signal input periodLen;
    signal input totalCap;
    signal input capabilityRoot;
    signal input counterpartyRoot;
    signal input expiry;
    signal input salt;

    // Private counter state before this spend.
    signal input oldPeriod;
    signal input oldSpent;
    signal input oldTotal;

    // Where the payee sits in the counterparty tree.
    signal input pathElements[counterpartyDepth];
    signal input pathIndices[counterpartyDepth];

    // Where the capability sits in the capability tree.
    signal input capabilityPathElements[capabilityDepth];
    signal input capabilityPathIndices[capabilityDepth];

    // The mandate address is bound into the nullifier below; squaring it as well keeps the
    // input in the constraint system even if that ever changes.
    signal mandateSquared <== mandate * mandate;

    // Range checks. Every comparator below assumes its inputs fit its bit width, and the two
    // capability halves have to be the halves of one 32-byte id.
    component amountBits = Num2Bits(128);
    amountBits.in <== amount;
    component perCallBits = Num2Bits(128);
    perCallBits.in <== perCallCap;
    component periodCapBits = Num2Bits(128);
    periodCapBits.in <== periodCap;
    component totalCapBits = Num2Bits(128);
    totalCapBits.in <== totalCap;
    component oldSpentBits = Num2Bits(128);
    oldSpentBits.in <== oldSpent;
    component oldTotalBits = Num2Bits(128);
    oldTotalBits.in <== oldTotal;
    component capabilityHiBits = Num2Bits(128);
    capabilityHiBits.in <== capabilityHi;
    component capabilityLoBits = Num2Bits(128);
    capabilityLoBits.in <== capabilityLo;
    component nowBits = Num2Bits(64);
    nowBits.in <== now;
    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiry;
    component periodLenBits = Num2Bits(64);
    periodLenBits.in <== periodLen;
    component oldPeriodBits = Num2Bits(64);
    oldPeriodBits.in <== oldPeriod;

    // 1. The terms are the committed ones.
    component terms = Poseidon(8);
    terms.inputs[0] <== perCallCap;
    terms.inputs[1] <== periodCap;
    terms.inputs[2] <== periodLen;
    terms.inputs[3] <== totalCap;
    terms.inputs[4] <== capabilityRoot;
    terms.inputs[5] <== counterpartyRoot;
    terms.inputs[6] <== expiry;
    terms.inputs[7] <== salt;
    terms.out === termsCommitment;

    // 2. The old counter is the one the account holds.
    component oldC = Poseidon(5);
    oldC.inputs[0] <== oldPeriod;
    oldC.inputs[1] <== oldSpent;
    oldC.inputs[2] <== oldTotal;
    oldC.inputs[3] <== salt;
    oldC.inputs[4] <== nonce;
    oldC.out === oldCounter;

    // 3. The current period: now = period * periodLen + rest, rest < periodLen.
    component lenZero = IsZero();
    lenZero.in <== periodLen;
    lenZero.out === 0;

    signal period <-- now \ periodLen;
    signal rest <-- now % periodLen;
    component periodBits = Num2Bits(64);
    periodBits.in <== period;
    component restBits = Num2Bits(64);
    restBits.in <== rest;
    now === period * periodLen + rest;
    component restLt = LessThan(64);
    restLt.in[0] <== rest;
    restLt.in[1] <== periodLen;
    restLt.out === 1;

    // Time only moves forward, so a proof cannot rewind into an older period with a fresh cap.
    component forward = GreaterEqThan(64);
    forward.in[0] <== period;
    forward.in[1] <== oldPeriod;
    forward.out === 1;

    component samePeriod = IsEqual();
    samePeriod.in[0] <== period;
    samePeriod.in[1] <== oldPeriod;
    signal carried <== samePeriod.out * oldSpent;

    signal newSpent <== carried + amount;
    signal newTotal <== oldTotal + amount;

    // 4. The caps.
    component perCall = LessEqThan(129);
    perCall.in[0] <== amount;
    perCall.in[1] <== perCallCap;
    perCall.out === 1;

    component periodOk = LessEqThan(129);
    periodOk.in[0] <== newSpent;
    periodOk.in[1] <== periodCap;
    periodOk.out === 1;

    component totalOk = LessEqThan(129);
    totalOk.in[0] <== newTotal;
    totalOk.in[1] <== totalCap;
    totalOk.out === 1;

    // 5. The capability is in the capability set.
    component capabilityLeaf = Poseidon(2);
    capabilityLeaf.inputs[0] <== capabilityHi;
    capabilityLeaf.inputs[1] <== capabilityLo;
    component capabilities = MerkleRoot(capabilityDepth);
    capabilities.leaf <== capabilityLeaf.out;
    for (var i = 0; i < capabilityDepth; i++) {
        capabilities.pathElements[i] <== capabilityPathElements[i];
        capabilities.pathIndices[i] <== capabilityPathIndices[i];
    }
    capabilities.root === capabilityRoot;

    // 6. The payee is in the counterparty set.
    component leaf = Poseidon(1);
    leaf.inputs[0] <== payee;
    component tree = MerkleRoot(counterpartyDepth);
    tree.leaf <== leaf.out;
    for (var i = 0; i < counterpartyDepth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === counterpartyRoot;

    // 7. Not expired.
    component live = LessEqThan(64);
    live.in[0] <== now;
    live.in[1] <== expiry;
    live.out === 1;

    // 8. One nullifier per (mandate, period, nonce).
    component nul = Poseidon(4);
    nul.inputs[0] <== salt;
    nul.inputs[1] <== mandate;
    nul.inputs[2] <== period;
    nul.inputs[3] <== nonce;
    nul.out === nullifier;

    // 9. The new counter.
    component newC = Poseidon(5);
    newC.inputs[0] <== period;
    newC.inputs[1] <== newSpent;
    newC.inputs[2] <== newTotal;
    newC.inputs[3] <== salt;
    newC.inputs[4] <== nonce + 1;
    newC.out === newCounter;
}

component main {public [mandate, termsCommitment, oldCounter, newCounter, nullifier, amount, payee, capabilityHi, capabilityLo, now, nonce]} = WithinMandate(16, 8);
