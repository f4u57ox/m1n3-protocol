//! Place a V2 `BuyerHashpowerOrder<QuoteT>` (buyer-bound — no template
//! binding; survives template rotation).
//!
//! Args:
//!   1. SUI_RPC_URL
//!   2. KEYSTORE_PATH
//!   3. BUYER_ADDRESS                (signs the tx)
//!   4. SUI_PACKAGE id               (upgraded package — must expose place_buyer_order)
//!   5. QUOTE_COIN_TYPE              (fully-qualified, e.g. `0xdba…::usdc::USDC`)
//!   6. PRICE_PER_DIFFICULTY         (u64 µQuote per difficulty-1 unit)
//!   7. BUDGET                       (u64 µQuote initial Balance)
//!   8. IS_DYNAMIC                   (`true` | `false`)

use anyhow::{anyhow, Result};
use std::str::FromStr;
use sui_client::{execute_ptb_with_events, load_keystore_by_address};
use sui_sdk::{
    types::{
        base_types::{ObjectID, SuiAddress},
        crypto::SuiKeyPair,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::FundsWithdrawalArg,
        Identifier, TypeTag,
    },
    SuiClientBuilder,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 9 {
        eprintln!(
            "usage: {} RPC KEYSTORE BUYER PKG QUOTE_TYPE PRICE BUDGET IS_DYNAMIC",
            args[0]
        );
        std::process::exit(2);
    }
    let rpc = &args[1];
    let keystore = &args[2];
    let buyer_str = &args[3];
    let pkg_str = &args[4];
    let quote_type_str = &args[5];
    let price: u64 = args[6].parse().map_err(|e| anyhow!("price: {}", e))?;
    let budget: u64 = args[7].parse().map_err(|e| anyhow!("budget: {}", e))?;
    let is_dynamic: bool = args[8].parse().map_err(|e| anyhow!("is_dynamic: {}", e))?;

    let keypair: SuiKeyPair = load_keystore_by_address(keystore, buyer_str)?;
    let buyer = SuiAddress::from(&keypair.public());
    let package_id = ObjectID::from_str(pkg_str)?;
    let quote_type = TypeTag::from_str(quote_type_str)?;

    let client = SuiClientBuilder::default().build(rpc).await?;
    println!(
        "==> buyer {}\n==> placing BuyerHashpowerOrder<{}> at {} µQuote/diff, budget {} µQuote",
        buyer, quote_type_str, price, budget
    );

    let mut ptb = ProgrammableTransactionBuilder::new();

    // Pull `budget` from sender's address-balance accumulator.
    let w = ptb
        .funds_withdrawal(FundsWithdrawalArg::balance_from_sender(
            budget,
            quote_type.clone(),
        ))
        .map_err(|e| anyhow!("funds_withdrawal: {}", e))?;
    let coin = ptb.programmable_move_call(
        ObjectID::from_str("0x2")?,
        Identifier::from_str("coin")?,
        Identifier::from_str("redeem_funds")?,
        vec![quote_type.clone()],
        vec![w],
    );

    let price_arg = ptb.pure(price)?;
    let exp_arg = ptb.pure(Option::<u64>::None)?;
    let dyn_arg = ptb.pure(is_dynamic)?;

    // place_buyer_order<QuoteT>(payment, price, expires, is_dynamic, ctx)
    ptb.programmable_move_call(
        package_id,
        Identifier::from_str("pool")?,
        Identifier::from_str("place_buyer_order")?,
        vec![quote_type],
        vec![coin, price_arg, exp_arg, dyn_arg],
    );

    let resp = execute_ptb_with_events(&client, &keypair, buyer, 100_000_000, ptb.finish()).await?;
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
            if t.contains("BuyerHashpowerOrder") {
                println!("order_id: {}", object_id);
                println!("order_type: {}", t);
            }
        }
    }
    Ok(())
}
