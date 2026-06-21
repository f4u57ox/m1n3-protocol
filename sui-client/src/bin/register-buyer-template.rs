//! Standalone fresh-Template publisher for a buyer-bound order lane.
//!
//! Pairs with V2 `BuyerHashpowerOrder<QuoteT>` (which has no template
//! binding). Call this repeatedly — once per Bitcoin tip / mempool
//! refresh — to publish a new buyer-owned `Template` without touching
//! the order. The sidecar's `submit_share_for_buyer_pay` accepts shares
//! against any Template whose `owner == order.buyer`, so the published
//! template id is just propagated to the stratum's
//! `--override-template-id` flag and that's it.
//!
//! Reads bytes from the most recent operator-published Template (saves
//! us re-implementing `getblocktemplate`) and re-publishes them under
//! the buyer wallet via `pool::register_template_public`. Burns 0.01
//! SUI per call as anti-spam.
//!
//! Args (positional):
//!   1. SUI_RPC_URL
//!   2. KEYSTORE_PATH
//!   3. BUYER_ADDRESS
//!   4. SUI_PACKAGE id            (upgraded package)
//!   5. ORIGINAL_SUI_PACKAGE id   (event-filter origin)
//!   6. POOL_OBJECT_ID

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::str::FromStr;
use sui_client::{execute_ptb_with_events, load_keystore_by_address};
use sui_sdk::{
    rpc_types::{
        EventFilter, ObjectChange, SuiMoveStruct, SuiMoveValue, SuiObjectDataOptions, SuiParsedData,
    },
    types::{
        base_types::{ObjectID, SequenceNumber, SuiAddress},
        crypto::SuiKeyPair,
        object::Owner,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{Argument, Command, ObjectArg, SharedObjectMutability},
        Identifier,
    },
    SuiClient, SuiClientBuilder,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 7 {
        eprintln!(
            "usage: {} RPC KEYSTORE BUYER PKG ORIG_PKG POOL_OBJ",
            args[0]
        );
        std::process::exit(2);
    }
    let rpc = &args[1];
    let keystore = &args[2];
    let buyer_str = &args[3];
    let pkg_str = &args[4];
    let orig_pkg_str = &args[5];
    let pool_obj_str = &args[6];

    let keypair: SuiKeyPair = load_keystore_by_address(keystore, buyer_str)?;
    let buyer = SuiAddress::from(&keypair.public());
    let package_id = ObjectID::from_str(pkg_str)?;
    let original_package_id = ObjectID::from_str(orig_pkg_str)?;
    let pool_id = ObjectID::from_str(pool_obj_str)?;

    let client = SuiClientBuilder::default().build(rpc).await?;
    println!("==> buyer wallet: {}", buyer);

    let src_id = find_recent_template_id(&client, original_package_id).await?;
    println!("==> source template: {}", src_id);
    let fields = read_template_fields(&client, src_id).await?;
    println!(
        "    height={} version={} nbits=0x{:08x} ntime={} branches={}",
        fields.height,
        fields.version,
        fields.nbits,
        fields.ntime,
        fields.merkle_branches.len()
    );

    let pool_iver = get_initial_shared_ver(&client, pool_id).await?;
    let new_template_id =
        register_buyer_template(&client, &keypair, buyer, package_id, pool_id, pool_iver, &fields)
            .await?;
    println!("==> buyer Template registered: {}", new_template_id);
    println!("    point your stratum's --override-template-id at this id.");
    Ok(())
}

// ── Helpers (duplicated from buyer-flow.rs — small enough to inline) ──────

struct TemplateFields {
    height: u64,
    prev_block_hash: Vec<u8>,
    coinbase1: Vec<u8>,
    coinbase2: Vec<u8>,
    merkle_branches: Vec<Vec<u8>>,
    version: u32,
    nbits: u32,
    ntime: u32,
}

async fn find_recent_template_id(
    client: &SuiClient,
    original_package_id: ObjectID,
) -> Result<ObjectID> {
    let event_type_str = format!("{}::pool::TemplateRegistered", original_package_id);
    let event_type = event_type_str
        .parse()
        .map_err(|e| anyhow!("event-type parse: {}", e))?;
    let r = client
        .event_api()
        .query_events(EventFilter::MoveEventType(event_type), None, Some(20), true)
        .await?;
    for ev in &r.data {
        let pj: &Value = &ev.parsed_json;
        if let Some(id) = pj.get("template_id").and_then(|v| v.as_str()) {
            return ObjectID::from_str(id).map_err(|e| anyhow!("template_id parse: {}", e));
        }
    }
    Err(anyhow!("no recent TemplateRegistered events"))
}

async fn read_template_fields(client: &SuiClient, id: ObjectID) -> Result<TemplateFields> {
    let r = client
        .read_api()
        .get_object_with_options(id, SuiObjectDataOptions::new().with_content())
        .await?;
    let d = r.data.ok_or_else(|| anyhow!("template {} not found", id))?;
    let content = d
        .content
        .ok_or_else(|| anyhow!("template missing content"))?;
    let fields = match content {
        SuiParsedData::MoveObject(o) => match o.fields {
            SuiMoveStruct::WithFields(m) => m,
            SuiMoveStruct::WithTypes { fields, .. } => fields,
            _ => return Err(anyhow!("unexpected SuiMoveStruct shape")),
        },
        _ => return Err(anyhow!("template not a move object")),
    };

    Ok(TemplateFields {
        height: parse_u64(&fields, "height")?,
        prev_block_hash: parse_byte_vec(&fields, "prev_block_hash")?,
        coinbase1: parse_byte_vec(&fields, "coinbase1")?,
        coinbase2: parse_byte_vec(&fields, "coinbase2")?,
        merkle_branches: parse_byte_vec_vec(&fields, "merkle_branches")?,
        version: parse_u64(&fields, "version")? as u32,
        nbits: parse_u64(&fields, "nbits")? as u32,
        ntime: parse_u64(&fields, "ntime")? as u32,
    })
}

fn parse_u64(m: &std::collections::BTreeMap<String, SuiMoveValue>, key: &str) -> Result<u64> {
    match m.get(key) {
        Some(SuiMoveValue::String(s)) => s.parse().map_err(|e| anyhow!("{}: {}", key, e)),
        Some(SuiMoveValue::Number(n)) => Ok(*n as u64),
        Some(other) => Err(anyhow!("{}: unexpected variant {:?}", key, other)),
        None => Err(anyhow!("{} missing", key)),
    }
}

fn parse_byte_vec(
    m: &std::collections::BTreeMap<String, SuiMoveValue>,
    key: &str,
) -> Result<Vec<u8>> {
    match m.get(key) {
        Some(SuiMoveValue::Vector(v)) => {
            let mut out = Vec::with_capacity(v.len());
            for el in v {
                if let SuiMoveValue::Number(n) = el {
                    out.push(*n as u8);
                } else {
                    return Err(anyhow!("{}: non-numeric byte element", key));
                }
            }
            Ok(out)
        }
        Some(other) => Err(anyhow!("{}: unexpected variant {:?}", key, other)),
        None => Err(anyhow!("{} missing", key)),
    }
}

fn parse_byte_vec_vec(
    m: &std::collections::BTreeMap<String, SuiMoveValue>,
    key: &str,
) -> Result<Vec<Vec<u8>>> {
    match m.get(key) {
        Some(SuiMoveValue::Vector(v)) => {
            let mut out = Vec::with_capacity(v.len());
            for el in v {
                if let SuiMoveValue::Vector(inner) = el {
                    let mut bytes = Vec::with_capacity(inner.len());
                    for b in inner {
                        if let SuiMoveValue::Number(n) = b {
                            bytes.push(*n as u8);
                        } else {
                            return Err(anyhow!("{}: non-numeric byte", key));
                        }
                    }
                    out.push(bytes);
                } else {
                    return Err(anyhow!("{}: non-vector inner element", key));
                }
            }
            Ok(out)
        }
        Some(other) => Err(anyhow!("{}: unexpected variant {:?}", key, other)),
        None => Err(anyhow!("{} missing", key)),
    }
}

async fn get_initial_shared_ver(
    client: &SuiClient,
    id: ObjectID,
) -> Result<SequenceNumber> {
    let r = client
        .read_api()
        .get_object_with_options(id, SuiObjectDataOptions::new().with_owner())
        .await?;
    let d = r
        .data
        .ok_or_else(|| anyhow!("shared object {} not found", id))?;
    let owner = d.owner.ok_or_else(|| anyhow!("owner not returned"))?;
    match owner {
        Owner::Shared {
            initial_shared_version,
        } => Ok(initial_shared_version),
        _ => Err(anyhow!("object {} is not shared", id)),
    }
}

async fn register_buyer_template(
    client: &SuiClient,
    keypair: &SuiKeyPair,
    buyer: SuiAddress,
    package_id: ObjectID,
    pool_id: ObjectID,
    pool_iver: SequenceNumber,
    f: &TemplateFields,
) -> Result<ObjectID> {
    let mut ptb = ProgrammableTransactionBuilder::new();

    let pool_arg = ptb
        .obj(ObjectArg::SharedObject {
            id: pool_id,
            initial_shared_version: pool_iver,
            mutability: SharedObjectMutability::Mutable,
        })
        .map_err(|e| anyhow!("pool arg: {}", e))?;

    // 0.01 SUI fee split off the gas coin.
    let fee_amount_arg = ptb.pure(10_000_000u64)?;
    let split_result = ptb.command(Command::SplitCoins(
        Argument::GasCoin,
        vec![fee_amount_arg],
    ));
    let fee_coin = match split_result {
        Argument::Result(idx) => Argument::NestedResult(idx, 0),
        other => return Err(anyhow!("expected Argument::Result, got {:?}", other)),
    };

    let clock_id = ObjectID::from_str("0x6")?;
    let clock_iver = get_initial_shared_ver(client, clock_id).await?;
    let clock_arg = ptb
        .obj(ObjectArg::SharedObject {
            id: clock_id,
            initial_shared_version: clock_iver,
            mutability: SharedObjectMutability::Immutable,
        })
        .map_err(|e| anyhow!("clock arg: {}", e))?;

    let height_arg = ptb.pure(f.height)?;
    let prev_arg = ptb.pure(f.prev_block_hash.clone())?;
    let cb1_arg = ptb.pure(f.coinbase1.clone())?;
    let cb2_arg = ptb.pure(f.coinbase2.clone())?;
    let branches_arg = ptb.pure(f.merkle_branches.clone())?;
    let version_arg = ptb.pure(f.version)?;
    let nbits_arg = ptb.pure(f.nbits)?;
    let ntime_arg = ptb.pure(f.ntime)?;

    ptb.programmable_move_call(
        package_id,
        Identifier::from_str("pool")?,
        Identifier::from_str("register_template_public")?,
        vec![],
        vec![
            pool_arg, fee_coin, clock_arg, height_arg, prev_arg, cb1_arg, cb2_arg, branches_arg,
            version_arg, nbits_arg, ntime_arg,
        ],
    );

    let resp = execute_ptb_with_events(client, keypair, buyer, 150_000_000, ptb.finish()).await?;
    if let Some(eff) = &resp.effects {
        use sui_sdk::rpc_types::SuiTransactionBlockEffectsAPI;
        let s = eff.status();
        if !matches!(s, sui_sdk::rpc_types::SuiExecutionStatus::Success) {
            return Err(anyhow!("register_template_public failed: {:?}", s));
        }
    }
    for oc in resp.object_changes.iter().flatten() {
        if let ObjectChange::Created {
            object_id,
            object_type,
            ..
        } = oc
        {
            if object_type.to_string().contains("::pool::Template") {
                return Ok(*object_id);
            }
        }
    }
    Err(anyhow!(
        "TemplateRegistered not in object_changes — digest {}",
        resp.digest
    ))
}
