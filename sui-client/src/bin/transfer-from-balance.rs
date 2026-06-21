//! Transfer `Coin<T>` from the sender's address-balance to a recipient.
//!
//! Address balances (the new mainnet fast-path bucket) can't be moved with
//! `sui client transfer` because the legacy CLI doesn't know how to construct
//! a `FundsWithdrawalArg`. This binary pulls `amount` units of `T` out of the
//! sender's accumulator via `0x2::coin::redeem_funds<Balance<T>>`, then
//! transfers the resulting `Coin<T>` to `recipient`.
//!
//! Args:
//!   1. SUI_RPC_URL
//!   2. KEYSTORE_PATH
//!   3. SENDER (0x… signs the tx, holds the address-balance)
//!   4. RECIPIENT (0x… destination)
//!   5. COIN_TYPE (fully-qualified, e.g. `0xdba…::usdc::USDC`)
//!   6. AMOUNT (u64, base units — µUSDC for USDC etc.)

use anyhow::{anyhow, Result};
use std::str::FromStr;
use sui_client::{execute_ptb_with_events, load_keystore_by_address};
use sui_sdk::{
    types::{
        base_types::{ObjectID, SuiAddress},
        crypto::SuiKeyPair,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{Command, FundsWithdrawalArg},
        Identifier, TypeTag,
    },
    SuiClientBuilder,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 7 {
        eprintln!(
            "usage: {} RPC KEYSTORE SENDER RECIPIENT COIN_TYPE AMOUNT",
            args[0]
        );
        std::process::exit(2);
    }
    let rpc = &args[1];
    let keystore = &args[2];
    let sender_str = &args[3];
    let recipient_str = &args[4];
    let type_str = &args[5];
    let amount: u64 = args[6].parse().map_err(|e| anyhow!("amount: {}", e))?;

    let keypair: SuiKeyPair = load_keystore_by_address(keystore, sender_str)?;
    let sender = SuiAddress::from(&keypair.public());
    let recipient = SuiAddress::from_str(recipient_str)?;
    let coin_type = TypeTag::from_str(type_str)?;

    let client = SuiClientBuilder::default().build(rpc).await?;
    println!(
        "==> sending {} units of {} from {} → {}",
        amount, type_str, sender, recipient
    );

    let mut ptb = ProgrammableTransactionBuilder::new();
    let w = ptb
        .funds_withdrawal(FundsWithdrawalArg::balance_from_sender(
            amount,
            coin_type.clone(),
        ))
        .map_err(|e| anyhow!("funds_withdrawal: {}", e))?;
    let coin = ptb.programmable_move_call(
        ObjectID::from_str("0x2")?,
        Identifier::from_str("coin")?,
        Identifier::from_str("redeem_funds")?,
        vec![coin_type],
        vec![w],
    );
    let to_arg = ptb.pure(recipient)?;
    ptb.command(Command::TransferObjects(vec![coin], to_arg));

    let resp = execute_ptb_with_events(&client, &keypair, sender, 100_000_000, ptb.finish()).await?;
    println!("digest: {}", resp.digest);
    if let Some(eff) = &resp.effects {
        use sui_sdk::rpc_types::SuiTransactionBlockEffectsAPI;
        println!("status: {:?}", eff.status());
    }
    Ok(())
}
