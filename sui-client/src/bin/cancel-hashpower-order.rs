//! Cancel a V1 `HashpowerBuyOrder<QuoteT>` and refund its remaining budget.
//!
//! Args:
//!   1. SUI_RPC_URL
//!   2. KEYSTORE_PATH
//!   3. BUYER_ADDRESS (must equal order.buyer)
//!   4. SUI_PACKAGE id (latest — the entry still resolves via upgrade compat)
//!   5. ORDER_ID
//!   6. QUOTE_COIN_TYPE (e.g. `0xdba…::usdc::USDC`)

use anyhow::{anyhow, Result};
use std::str::FromStr;
use sui_client::{execute_ptb_with_events, load_keystore_by_address};
use sui_sdk::{
    rpc_types::SuiObjectDataOptions,
    types::{
        base_types::{ObjectID, SuiAddress},
        crypto::SuiKeyPair,
        object::Owner,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{Command, ObjectArg, SharedObjectMutability},
        Identifier, TypeTag,
    },
    SuiClientBuilder,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 7 {
        eprintln!(
            "usage: {} RPC KEYSTORE BUYER PKG ORDER_ID QUOTE_TYPE",
            args[0]
        );
        std::process::exit(2);
    }
    let rpc = &args[1];
    let keystore = &args[2];
    let buyer_str = &args[3];
    let pkg_str = &args[4];
    let order_str = &args[5];
    let quote_type_str = &args[6];

    let keypair: SuiKeyPair = load_keystore_by_address(keystore, buyer_str)?;
    let buyer = SuiAddress::from(&keypair.public());
    let package_id = ObjectID::from_str(pkg_str)?;
    let order_id = ObjectID::from_str(order_str)?;
    let quote_type = TypeTag::from_str(quote_type_str)?;

    let client = SuiClientBuilder::default().build(rpc).await?;

    // Order is shared — need initial_shared_version.
    let r = client
        .read_api()
        .get_object_with_options(order_id, SuiObjectDataOptions::new().with_owner())
        .await?;
    let d = r.data.ok_or_else(|| anyhow!("order {} not found", order_id))?;
    let owner = d.owner.ok_or_else(|| anyhow!("owner missing"))?;
    let iver = match owner {
        Owner::Shared {
            initial_shared_version,
        } => initial_shared_version,
        _ => return Err(anyhow!("order not a shared object")),
    };

    let mut ptb = ProgrammableTransactionBuilder::new();
    let order_arg = ptb
        .obj(ObjectArg::SharedObject {
            id: order_id,
            initial_shared_version: iver,
            mutability: SharedObjectMutability::Mutable,
        })
        .map_err(|e| anyhow!("order arg: {}", e))?;

    let refund = ptb.programmable_move_call(
        package_id,
        Identifier::from_str("pool")?,
        Identifier::from_str("cancel_hashpower_order")?,
        vec![quote_type],
        vec![order_arg],
    );

    let recipient = ptb.pure(buyer)?;
    ptb.command(Command::TransferObjects(vec![refund], recipient));

    let resp = execute_ptb_with_events(&client, &keypair, buyer, 50_000_000, ptb.finish()).await?;
    println!("digest: {}", resp.digest);
    if let Some(eff) = &resp.effects {
        use sui_sdk::rpc_types::SuiTransactionBlockEffectsAPI;
        println!("status: {:?}", eff.status());
    }
    Ok(())
}
