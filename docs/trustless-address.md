# The trustless reward address

> Where the BTC coinbase output actually goes — and why nobody picks it.

This is the long form of [the trick](../README.md#the-trick) the README
leads with. The short version: the BTC recipient is a deterministic
function of two things the operator does not control:

1. a 32-byte `UID` Sui generates when the `HashiVault<BTC>` shared
   object is created, and
2. the Hashi MPC committee's aggregated public key (`master_g`).

That's it. There is no `pool_btc_address` knob. There is no
`set_payout_wallet` admin function. There is no off-chain config file
to swap. The address is on-chain math.

## Step 1 — Sui generates the UID

The vault is constructed by one Move call:

```move
// contracts/sources/hashi_vault.move:100
public fun create_shared<HBTC>(_cap: &PoolAdminCap, ctx: &mut TxContext) {
    let vault = HashiVault<HBTC> {
        id: object::new(ctx),
        hbtc: balance::zero<HBTC>(),
        sui: balance::zero<SUI>(),
        // …
    };
    let vault_id = object::uid_to_address(&vault.id);
    event::emit(VaultCreated {
        vault_id,
        derivation_path: vault_id,
    });
    transfer::share_object(vault);
}
```

`object::new(ctx)` is a Sui framework call. It allocates a fresh
`UID` whose 32-byte address is `H(tx_digest || creation_index)`. The
caller has no input into what that 32 bytes is. The published
`VaultCreated` event is what Hashi's indexer picks up and treats as the
`derivation_path` for everything that follows.

Our deployed vault on devnet:

```
vault_id  = 0x816808e9ce5586771ac1125f3530bf62c3da5416ce58b11a373596e684c810db
```

That's the only operator-visible parameter to the next step, and it
came from Sui, not from us.

## Step 2 — Hashi derives the Taproot output key

Hashi's MPC committee holds the secret share for `master_g`. The
public `master_g` is published on chain as part of the Hashi shared
object. The committee derives a per-deposit child key per BIP-340/341.
We reproduce the same derivation locally with `hashi-derive-address`:

```rust
// hashi-derive/src/main.rs:113
fn derive_child_xonly(
    master_g_arkbytes: &[u8; 33],
    sui_addr: &[u8; 32],
) -> Result<XOnlyPublicKey> {
    let (master_x_be, master_sec1) = parse_master_g(master_g_arkbytes)?;
    let master = PublicKey::from_slice(&master_sec1)?;

    // ikm = master.x_be || sui_addr
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(&master_x_be);
    ikm.extend_from_slice(sui_addr);

    // HKDF-SHA3-256, no salt, no info, 64-byte OKM.
    let hk = Hkdf::<Sha3_256>::new(None, &ikm);
    let mut okm = [0u8; 64];
    hk.expand(&[], &mut okm)?;

    // Reduce mod n (secp256k1 group order).
    let t_fr = Fr::from_be_bytes_mod_order(&okm);
    let tweak = Scalar::from_be_bytes(/* t_fr as 32 BE bytes */)?;

    // derived = master + t·G
    let derived = master.add_exp_tweak(SECP256K1, &tweak)?;

    // BIP-340 x-only (force even-Y).
    let (xonly, _) = derived.x_only_public_key();
    Ok(xonly)
}
```

This is the child x-only pubkey. The committee then applies a BIP-341
Taproot tweak with a NUMS (nothing-up-my-sleeve) internal key — meaning
no script path can be exercised, only the key path that requires the
committee's threshold signature. The result is the 32-byte witness
program that gets baked into a P2TR `OP_1 OP_PUSHBYTES_32 <program>`.

## Step 3 — The worked example

Running the derivation against our deployed devnet vault:

```bash
./target/release/hashi-derive-address \
  --sui-addr 0x816808e9ce5586771ac1125f3530bf62c3da5416ce58b11a373596e684c810db \
  --master-g <Hashi mpc_public_key from chain> \
  --network signet
```

Output:

```text
witness version : 1
witness program : 94ea0220dc9efa8deb7d070ca97f47e14ee84bcaba8de0dbc86dbf2410e02ad8
scriptPubKey    : 5120 94ea0220dc9efa8deb7d070ca97f47e14ee84bcaba8de0dbc86dbf2410e02ad8

bech32 (signet) : tb1pjn4qygxunmagm6maqux2jl68u98wsj72h2x7pk7gdkljgy8q9tvq7xsppx
bech32 (mainnet): bc1pjn4qygxunmagm6maqux2jl68u98wsj72h2x7pk7gdkljgy8q9tvqfwxwmf
```

The 32-byte witness program (`94ea0220…0ad8`) is network-independent.
The HRP (`tb1p` vs `bc1p`) is purely encoding; the spendability
condition is identical on both networks.

## Step 4 — The stratum server bakes that address into every coinbase

The stratum server reads `POOL_ADDRESS` from `.env` as a hex-encoded
scriptPubKey. We set it to the derived value above:

```bash
# .env
POOL_ADDRESS=512094ea0220dc9efa8deb7d070ca97f47e14ee84bcaba8de0dbc86dbf2410e02ad8
```

On startup, the server logs:

```text
INFO stratum_server: Pool address script: 5120…0ad8 (34 bytes)
```

— and that 34-byte script becomes `vout[0].scriptPubKey` in every
coinbase tx the server constructs from a Bitcoin RPC template. If
`POOL_ADDRESS` is missing the server warns loudly:

```text
WARN stratum_server: No --pool-address specified! Coinbase outputs will
                     be UNSPENDABLE (all-zero P2PKH)
```

That warning is on purpose: it makes the misconfiguration loud rather
than silent. We hit it earlier in development and the dapp's templates
page surfaced the `1111111111111111111114oLvT2` placeholder address,
which is the canonical Base58 encoding of the all-zero hash160 (i.e.,
"this output is intentionally unspendable, fix your config").

## Why this matters

The operator's `PoolAdminCap` lets them register block templates and
adjust difficulty. It does not let them:

- choose where the BTC coinbase goes (script comes from on-chain math),
- drain the vault (`take_exact_hbtc` is `public(package)`-only and the
  one caller is the permissionless `open_and_fund_round_batch`),
- redirect a miner's reward share (`claim_reward` is gated on the
  miner's owned `MinerWorkRecord`),
- or skip the Hashi committee (the committee's threshold signature is
  the *only* way the P2TR can ever be spent).

The reward routing is structurally trustless. The operator is reduced
to a publisher of templates — useful, but not custodial.

## What this design borrows from where

- **Sui's owned-object UID semantics** give us an unforgeable per-vault
  identifier in 32 bytes.
- **Hashi's deposit derivation** uses HKDF-SHA3-256 + scalar add per
  BIP-340 to derive child keys without requiring a key-agg round per
  deposit.
- **Bitcoin's BIP-341 Taproot** is what lets us commit to a key-path-only
  spend (via NUMS internal key) so the committee can never be forced
  into a script-path exit.

The contribution m1n3 makes on top is the *binding* between (1) and (2):
demonstrating that an MPC bridge's per-deposit derivation can be driven
by a chain-generated UID, removing the last "human picks the address"
step from a mining-pool reward flow.
