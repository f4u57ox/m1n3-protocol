//! Ed25519 keypair loading and Sui-compatible signing.
//!
//! Key format accepted:
//!   - Bech32 `suiprivkey1…` — output of `sui keytool export --key-identity <addr>`
//!   - 64-char hex — raw 32-byte ed25519 private key

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bech32::Hrp;
use ed25519_dalek::{Signer, SigningKey};
use blake2::{Blake2b, digest::{Update, FixedOutput, typenum::U32}};

use crate::bcs_types::INTENT_PREFIX;

const ED25519_FLAG: u8 = 0x00;

pub struct SuiKeypair {
    signing_key: SigningKey,
    pub address: [u8; 32],
}

impl SuiKeypair {
    /// Parse a bech32 `suiprivkey1…` private key string (from `sui keytool export`).
    pub fn from_bech32(s: &str) -> Result<Self> {
        let (hrp, data) = bech32::decode(s)
            .context("failed to decode bech32 private key")?;

        anyhow::ensure!(
            hrp == Hrp::parse("suiprivkey").unwrap(),
            "expected hrp 'suiprivkey', got '{}'", hrp
        );

        // data is already a Vec<u8> from bech32 v0.11
        anyhow::ensure!(data.len() == 33, "expected 33 bytes (flag + 32-byte key), got {}", data.len());
        anyhow::ensure!(data[0] == ED25519_FLAG, "only ed25519 keys supported (flag 0x00)");

        let key_bytes: [u8; 32] = data[1..33].try_into().unwrap();
        Self::from_raw_bytes(&key_bytes)
    }

    /// Parse a 64-char hex-encoded raw ed25519 private key (32 bytes).
    pub fn from_hex(s: &str) -> Result<Self> {
        let bytes = hex::decode(s.trim_start_matches("0x"))
            .context("private key must be 64 hex chars (32 bytes)")?;
        anyhow::ensure!(bytes.len() == 32, "expected 32 bytes, got {}", bytes.len());
        let key_bytes: [u8; 32] = bytes.try_into().unwrap();
        Self::from_raw_bytes(&key_bytes)
    }

    fn from_raw_bytes(key_bytes: &[u8; 32]) -> Result<Self> {
        let signing_key   = SigningKey::from_bytes(key_bytes);
        let pubkey_bytes  = signing_key.verifying_key().to_bytes();

        // Sui address = BLAKE2b-256([flag] || pubkey)
        let mut h = Blake2b::<U32>::default();
        h.update(&[ED25519_FLAG]);
        h.update(&pubkey_bytes);
        let address: [u8; 32] = h.finalize_fixed().into();

        Ok(Self { signing_key, address })
    }

    /// Parse from either bech32 (`suiprivkey1…`) or 64-char hex.
    pub fn parse(s: &str) -> Result<Self> {
        if s.starts_with("suiprivkey") {
            Self::from_bech32(s)
        } else {
            Self::from_hex(s)
        }
    }

    /// Sign BCS-encoded transaction bytes and return a base64 Sui signature.
    ///
    /// Sui signature format (97 bytes, then base64):
    ///   `[flag=0x00] || [ed25519_sig(64)] || [ed25519_pubkey(32)]`
    pub fn sign_transaction(&self, tx_bytes: &[u8]) -> String {
        // Sui signing: Blake2b-256(intent_prefix || tx_bytes), then Ed25519-sign the 32-byte digest
        let mut intent_msg = Vec::with_capacity(INTENT_PREFIX.len() + tx_bytes.len());
        intent_msg.extend_from_slice(&INTENT_PREFIX);
        intent_msg.extend_from_slice(tx_bytes);

        let mut h = Blake2b::<U32>::default();
        h.update(&intent_msg);
        let digest = h.finalize_fixed();

        let sig     = self.signing_key.sign(&digest);
        let pubkey  = self.signing_key.verifying_key().to_bytes();

        let mut full = Vec::with_capacity(97);
        full.push(ED25519_FLAG);
        full.extend_from_slice(&sig.to_bytes());
        full.extend_from_slice(&pubkey);

        STANDARD.encode(&full)
    }

    pub fn address_hex(&self) -> String {
        format!("0x{}", hex::encode(self.address))
    }
}
