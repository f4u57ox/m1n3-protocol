//! Programmable Transaction Block builder.
//!
//! Constructs a `ProgrammableTransaction`, wraps it in `TransactionData`,
//! BCS-encodes it, and hands the bytes back for signing.
//!
//! Usage pattern:
//! ```ignore
//! let mut ptb = PtbBuilder::new();
//! let pool = ptb.shared_object(pool_id, shared_version, true);
//! let amount = ptb.pure_u64(reward_mist)?;
//! let [payment] = ptb.split_coins(Argument::GasCoin, &[amount]);
//! ptb.move_call("pool", "post_job", vec![pool, ..., payment]);
//! let tx_bytes = ptb.build(sender, gas_ref, gas_price, gas_budget)?;
//! ```

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::bcs_types::{
    Argument, CallArg, Command, GasData, ObjectArg, ObjectId,
    ObjectRef, ProgrammableMoveCall, ProgrammableTransaction, SequenceNumber,
    TransactionData, TransactionDataV1, TransactionExpiration, TransactionKind,
};

pub struct PtbBuilder {
    inputs:   Vec<CallArg>,
    commands: Vec<Command>,
}

impl PtbBuilder {
    pub fn new() -> Self {
        Self { inputs: vec![], commands: vec![] }
    }

    // ── Input helpers ─────────────────────────────────────────────────────────

    fn add_input(&mut self, arg: CallArg) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(arg);
        Argument::Input(idx)
    }

    /// Add a mutable shared object input.
    pub fn shared_object(
        &mut self,
        id:                     ObjectId,
        initial_shared_version: SequenceNumber,
        mutable:                bool,
    ) -> Argument {
        self.add_input(CallArg::Object(ObjectArg::SharedObject {
            id, initial_shared_version, mutable,
        }))
    }

    /// Add a pure `Vec<u8>` input (Move `vector<u8>`).
    pub fn pure_bytes(&mut self, v: Vec<u8>) -> Result<Argument> {
        Ok(self.add_input(CallArg::Pure(bcs::to_bytes(&v)?)))
    }

    /// Add a pure `Vec<Vec<u8>>` input (Move `vector<vector<u8>>`).
    pub fn pure_bytes_vec(&mut self, v: Vec<Vec<u8>>) -> Result<Argument> {
        Ok(self.add_input(CallArg::Pure(bcs::to_bytes(&v)?)))
    }

    /// Add a pure `u32` input.
    pub fn pure_u32(&mut self, v: u32) -> Result<Argument> {
        Ok(self.add_input(CallArg::Pure(bcs::to_bytes(&v)?)))
    }

    /// Add a pure `u64` input.
    pub fn pure_u64(&mut self, v: u64) -> Result<Argument> {
        Ok(self.add_input(CallArg::Pure(bcs::to_bytes(&v)?)))
    }

    /// Add a pure `Vec<u8>` input for a Move `vector<u8>` where the bytes
    /// are already the _inner_ bytes (not BCS-encoded externally).
    pub fn pure_raw_bytes(&mut self, v: &[u8]) -> Result<Argument> {
        Ok(self.add_input(CallArg::Pure(bcs::to_bytes(&v.to_vec())?)))
    }

    // ── Command helpers ───────────────────────────────────────────────────────

    /// `SplitCoins(coin, [amounts...])` — returns one Argument per amount.
    ///
    /// Amounts are specified as pre-added `Argument::Input(n)` pure u64 values.
    pub fn split_coins(&mut self, coin: Argument, amounts: &[Argument]) -> Vec<Argument> {
        let cmd_idx = self.commands.len() as u16;
        self.commands.push(Command::SplitCoins(coin, amounts.to_vec()));
        (0..amounts.len() as u16)
            .map(|i| Argument::NestedResult(cmd_idx, i))
            .collect()
    }

    /// `TransferObjects([objs], recipient_address)`.
    pub fn transfer_objects(&mut self, objects: Vec<Argument>, recipient: [u8; 32]) {
        use crate::bcs_types::{CallArg, Command};
        let recipient_arg = self.add_input(CallArg::Pure(bcs::to_bytes(&recipient.to_vec()).unwrap()));
        self.commands.push(Command::TransferObjects(objects, recipient_arg));
    }

    /// `MoveCall(package, module, function, [], args)`.
    pub fn move_call(
        &mut self,
        package:  ObjectId,
        module:   &str,
        function: &str,
        args:     Vec<Argument>,
    ) {
        self.commands.push(Command::MoveCall(ProgrammableMoveCall {
            package,
            module:         module.to_string(),
            function:       function.to_string(),
            type_arguments: vec![],
            arguments:      args,
        }));
    }

    // ── Build ─────────────────────────────────────────────────────────────────

    /// Assemble the complete `TransactionData`, BCS-encode it, and return
    /// the base64 string ready for `sui_executeTransactionBlock`.
    pub fn build(
        self,
        sender:     ObjectId,
        gas_ref:    ObjectRef,
        gas_price:  u64,
        gas_budget: u64,
    ) -> Result<String> {
        let pt = ProgrammableTransaction {
            inputs:   self.inputs,
            commands: self.commands,
        };

        let tx_data = TransactionData::V1(TransactionDataV1 {
            kind:     TransactionKind::ProgrammableTransaction(pt),
            sender,
            gas_data: GasData {
                payment: vec![gas_ref],
                owner:   sender,
                price:   gas_price,
                budget:  gas_budget,
            },
            expiration: TransactionExpiration::None,
        });

        let bytes = bcs::to_bytes(&tx_data)?;
        Ok(STANDARD.encode(&bytes))
    }
}
