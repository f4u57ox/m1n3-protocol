//! Bespoke `place_hashpower_order` driver.
//!
//! Uses the address-balance fast path: pulls `budget` of `QuoteT` directly out
//! of the sender's address balance via `FundsWithdrawalArg` and converts it to
//! a `Coin<QuoteT>` inside the PTB via `0x2::coin::redeem_funds`. Bypasses the
//! Sui 1.73 CLI's stale-replica behaviour on freshly-received coins, which
//! consistently surfaces "Object not found" for the USDC coin even when
//! `sui_getObject` against the same RPC URL succeeds.
//!
//! Args (positional):
//!   1. SUI_RPC_URL
//!   2. KEYSTORE_PATH
//!   3. SUI_ADDRESS                (signer / template owner / buyer)
//!   4. SUI_PACKAGE id              (upgraded package containing pool::place_hashpower_order)
//!   5. TEMPLATE_ID                 (buyer-owned `pool::Template` to bind the order to)
//!   6. QUOTE_COIN_TYPE             (fully-qualified, e.g. `0xdba…::usdc::USDC`)
//!   7. PRICE_PER_DIFFICULTY        (u64, µQuote per difficulty-1 unit)
//!   8. BUDGET                      (u64, µQuote initial Balance for the order)
//!   9. IS_DYNAMIC                  (`true` | `false`)

use anyhow::{anyhow, Result};
use std::str::FromStr;
use sui_client::{execute_ptb_with_events, load_keystore_by_address};
use sui_sdk::{
    rpc_types::SuiObjectDataOptions,
    types::{
        base_types::{ObjectID, SuiAddress},
        crypto::SuiKeyPair,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{Argument, Command, FundsWithdrawalArg, ObjectArg},
        Identifier, TypeTag,
    },
    SuiClientBuilder,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 10 {
        eprintln!(
            "usage: {} RPC KEYSTORE ADDR PKG TEMPLATE_ID QUOTE_TYPE PRICE BUDGET IS_DYNAMIC",
            args[0]
        );
        std::process::exit(2);
    }
    let rpc = &args[1];
    let keystore = &args[2];
    let sender_str = &args[3];
    let pkg_str = &args[4];
    let template_str = &args[5];
    let quote_type_str = &args[6];
    let price: u64 = args[7].parse().map_err(|e| anyhow!("price: {}", e))?;
    let budget: u64 = args[8].parse().map_err(|e| anyhow!("budget: {}", e))?;
    let is_dynamic: bool = args[9].parse().map_err(|e| anyhow!("is_dynamic: {}", e))?;

    let keypair: SuiKeyPair = load_keystore_by_address(keystore, sender_str)?;
    let sender = SuiAddress::from(&keypair.public());
    let package_id = ObjectID::from_str(pkg_str)?;
    let template_id = ObjectID::from_str(template_str)?;
    let quote_type = TypeTag::from_str(quote_type_str)?;

    let client = SuiClientBuilder::default().build(rpc).await?;
    println!(
        "==> signer {}\n==> pulling {} µQuote of {} from address balance",
        sender, budget, quote_type_str
    );

    let mut ptb = ProgrammableTransactionBuilder::new();

    // ── 1. Reserve `budget` from the sender's `Balance<QuoteT>` accumulator.
    //
    //    Returns a `Withdrawal<Balance<QuoteT>>` (intent token) — not a
    //    Coin yet. The 0x2::coin::redeem_funds call below consumes it.
    let withdrawal_arg = ptb
        .funds_withdrawal(FundsWithdrawalArg::balance_from_sender(
            budget,
            quote_type.clone(),
        ))
        .map_err(|e| anyhow!("funds_withdrawal: {}", e))?;

    // ── 2. Convert the Withdrawal to a real Coin<QuoteT>.
    //      `redeem_funds<Balance<T>>(Withdrawal<Balance<T>>, &mut TxContext) -> Coin<T>`
    let coin_arg = ptb.programmable_move_call(
        ObjectID::from_str("0x2")?,
        Identifier::from_str("coin")?,
        Identifier::from_str("redeem_funds")?,
        vec![quote_type.clone()],
        vec![withdrawal_arg],
    );

    // ── 3. Take the buyer-owned `pool::Template` (frozen immutable).
    let (tpl_ver, tpl_dig) = {
        let r = client
            .read_api()
            .get_object_with_options(template_id, SuiObjectDataOptions::new())
            .await?;
        let d = r
            .data
            .ok_or_else(|| anyhow!("template {} not found", template_id))?;
        (d.version, d.digest)
    };
    let tpl_arg = ptb
        .obj(ObjectArg::ImmOrOwnedObject((template_id, tpl_ver, tpl_dig)))
        .map_err(|e| anyhow!("tpl_arg: {}", e))?;

    let price_arg = ptb.pure(price)?;
    let exp_arg = ptb.pure(Option::<u64>::None)?;
    let dyn_arg = ptb.pure(is_dynamic)?;

    // ── 4. Call pool::place_hashpower_order<QuoteT>(tpl, coin, price, exp, dynamic).
    ptb.programmable_move_call(
        package_id,
        Identifier::from_str("pool")?,
        Identifier::from_str("place_hashpower_order")?,
        vec![quote_type],
        vec![tpl_arg, coin_arg, price_arg, exp_arg, dyn_arg],
    );

    let _ = Argument::Input(0); // silence unused-import in case the SDK rev rearranges

    let pt = ptb.finish();
    let resp = execute_ptb_with_events(&client, &keypair, sender, 100_000_000, pt).await?;
    println!("digest: {}", resp.digest);
    if let Some(eff) = &resp.effects {
        use sui_sdk::rpc_types::SuiTransactionBlockEffectsAPI;
        println!("status: {:?}", eff.status());
    }
    for oc in resp.object_changes.iter().flatten() {
        use sui_sdk::rpc_types::ObjectChange::*;
        if let Created {
            object_id,
            object_type,
            ..
        } = oc
        {
            let t = object_type.to_string();
            if t.contains("HashpowerBuyOrder") {
                println!("order_id: {}", object_id);
                println!("order_type: {}", t);
            }
        }
    }
    Ok(())
}
