//! Minimal Sui JSON-RPC client + BCS Programmable Transaction Block builder.
//!
//! Avoids the heavy `sui-sdk` git dependency. Instead:
//!   - `SuiRpcClient` talks to a Sui full node via JSON-RPC (`reqwest`).
//!   - `PtbBuilder` assembles a typed `ProgrammableTransaction` and BCS-encodes it.
//!   - `SuiKeypair` loads an ed25519 private key and produces Sui-compatible signatures.
//!
//! Supported PTB commands (all this protocol needs):
//!   - `SplitCoins(GasCoin, [amount])` — split reward from gas coin
//!   - `MoveCall(package, module, function, type_args=[], args)` — call contract entry fn
//!
//! All other Sui transaction infrastructure is handled directly here so the rest
//! of the workspace only sees clean async `post_job` / `submit_share` APIs.

pub mod bcs_types;
pub mod keypair;
pub mod ptb;
pub mod rpc;

pub use keypair::SuiKeypair;
pub use ptb::PtbBuilder;
pub use rpc::SuiRpcClient;
