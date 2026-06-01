//! BCS-serializable representations of Sui transaction types.
//!
//! Field ordering and enum variant indices must match the Sui source exactly —
//! any mismatch causes the full node to reject the transaction with a decode error.
//!
//! References:
//!   sui-types/src/transaction.rs — TransactionData, Command, CallArg, Argument
//!   sui-types/src/base_types.rs  — ObjectID, SuiAddress, SequenceNumber

#![allow(dead_code)] // many variants exist only for correct enum indices

use serde::{Deserialize, Serialize};

// ── Primitive aliases ─────────────────────────────────────────────────────────

/// A 32-byte Sui object or address ID, serialized as raw bytes in BCS.
pub type ObjectId = [u8; 32];

/// A monotonically increasing object version counter (u64 LE in BCS).
pub type SequenceNumber = u64;

/// An object content digest (SHA-256).
///
/// Sui's `Digest` type uses `serde_bytes` (length-prefixed in BCS), unlike
/// `AccountAddress` which serializes as a raw `[u8; 32]`. This newtype
/// mirrors that: serializes via `serialize_bytes` so the full node can parse it.
#[derive(Clone, Copy, Debug)]
pub struct ObjectDigest(pub [u8; 32]);

impl serde::Serialize for ObjectDigest {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(&self.0)
    }
}

/// `(ObjectID, SequenceNumber, ObjectDigest)` — uniquely identifies a specific
/// version of an owned or immutable object.
pub type ObjectRef = (ObjectId, SequenceNumber, ObjectDigest);

// ── Top-level transaction wrapper ─────────────────────────────────────────────

/// Root of a Sui transaction.  Variant 0 = V1 (the only live variant).
#[derive(Serialize)]
pub enum TransactionData {
    V1(TransactionDataV1),
}

#[derive(Serialize)]
pub struct TransactionDataV1 {
    pub kind:       TransactionKind,
    pub sender:     ObjectId, // SuiAddress is [u8;32]
    pub gas_data:   GasData,
    pub expiration: TransactionExpiration,
}

/// Variant 0 = ProgrammableTransaction (the only one we construct).
#[derive(Serialize)]
pub enum TransactionKind {
    ProgrammableTransaction(ProgrammableTransaction),
}

#[derive(Serialize)]
pub struct ProgrammableTransaction {
    pub inputs:   Vec<CallArg>,
    pub commands: Vec<Command>,
}

// ── Call arguments ────────────────────────────────────────────────────────────

/// BCS variant ordering must match sui-types exactly.
#[derive(Serialize)]
pub enum CallArg {
    Pure(Vec<u8>),       // 0
    Object(ObjectArg),   // 1
}

/// Object argument modes.
#[derive(Serialize)]
pub enum ObjectArg {
    ImmOrOwnedObject(ObjectRef),                    // 0
    SharedObject {                                  // 1
        id:                     ObjectId,
        initial_shared_version: SequenceNumber,
        mutable:                bool,
    },
    Receiving(ObjectRef),                           // 2
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Variant indices 0-6 must stay fixed (consensus rule).
#[derive(Serialize)]
pub enum Command {
    MoveCall(ProgrammableMoveCall),                  // 0
    TransferObjects(Vec<Argument>, Argument),         // 1
    SplitCoins(Argument, Vec<Argument>),             // 2
    MergeCoins(Argument, Vec<Argument>),             // 3
    Publish(Vec<Vec<u8>>, Vec<ObjectId>),            // 4
    MakeMoveVec(Option<TypeTagBytes>, Vec<Argument>),// 5
    Upgrade(Vec<Vec<u8>>, Vec<ObjectId>, ObjectId, Argument), // 6
}

/// TypeTag as raw BCS bytes — only needed for MakeMoveVec (unused here).
/// We use a newtype so serde round-trips it correctly if ever needed.
#[derive(Serialize)]
pub struct TypeTagBytes(pub Vec<u8>);

#[derive(Serialize)]
pub struct ProgrammableMoveCall {
    pub package:        ObjectId,
    pub module:         String,        // Move Identifier (validated by full node)
    pub function:       String,        // Move Identifier
    pub type_arguments: Vec<TypeTagBytes>, // empty for all our calls
    pub arguments:      Vec<Argument>,
}

// ── Argument references ───────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug)]
pub enum Argument {
    GasCoin,              // 0
    Input(u16),           // 1
    Result(u16),          // 2
    NestedResult(u16, u16), // 3
}

// ── Gas / expiration ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GasData {
    pub payment: Vec<ObjectRef>,
    pub owner:   ObjectId,
    pub price:   u64,
    pub budget:  u64,
}

#[derive(Serialize)]
pub enum TransactionExpiration {
    None,        // 0
    Epoch(u64),  // 1
}

// ── Intent wrapper (not BCS-serialized as a struct, just a byte prefix) ───────

/// Prepend the 3-byte Sui transaction intent before signing.
/// Layout: IntentScope=0 (Transaction) | IntentVersion=0 | AppId=0 (Sui)
pub const INTENT_PREFIX: [u8; 3] = [0, 0, 0];

// ── JSON-RPC response types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RpcResponse<T> {
    pub result: Option<T>,
    pub error:  Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinData {
    pub coin_type:      String,
    pub coin_object_id: String,
    pub version:        String, // u64 as string
    pub digest:         String, // base58
    pub balance:        String, // u64 as string
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinPage {
    pub data:        Vec<CoinData>,
    pub next_cursor: Option<String>,
    pub has_next_page: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectResponse {
    pub data: Option<ObjectData>,
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectData {
    pub object_id: String,
    pub version:   String,
    pub digest:    String,
    pub owner:     Option<serde_json::Value>, // flexible — parsed manually
}

#[derive(Debug, Deserialize)]
pub struct ExecuteResponse {
    pub digest:  Option<String>,
    pub effects: Option<serde_json::Value>,
    pub error:   Option<serde_json::Value>,
}
