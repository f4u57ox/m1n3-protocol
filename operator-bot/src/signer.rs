//! Bitcoin signing abstraction.
//!
//! Only `OperatorSigner` exists in this build — it signs with a local
//! secp256k1 private key (WIF). The Ika / dWallet path is intentionally
//! omitted: this protocol uses Hashi for the Bitcoin bridge end-to-end.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use bitcoin::key::PrivateKey;
use bitcoin::secp256k1::{All, Message, Secp256k1, SecretKey};
use tracing::info;

use crate::config::BotConfig;

#[async_trait]
pub trait BitcoinSigner: Send + Sync {
    /// Sign a 32-byte message hash with the pool's Bitcoin key.
    /// Returns a 64-byte compact ECDSA signature (r || s).
    async fn sign_hash(&self, hash: &[u8; 32]) -> Result<[u8; 64]>;

    /// Compressed 33-byte secp256k1 public key.
    fn compressed_pubkey(&self) -> [u8; 33];
}

pub struct OperatorSigner {
    secp: Secp256k1<All>,
    secret: SecretKey,
    pubkey: [u8; 33],
}

#[async_trait]
impl BitcoinSigner for OperatorSigner {
    async fn sign_hash(&self, hash: &[u8; 32]) -> Result<[u8; 64]> {
        let msg = Message::from_digest(*hash);
        let sig = self.secp.sign_ecdsa(&msg, &self.secret);
        Ok(sig.serialize_compact())
    }

    fn compressed_pubkey(&self) -> [u8; 33] {
        self.pubkey
    }
}

pub fn make_signer(cfg: &BotConfig) -> Result<Box<dyn BitcoinSigner>> {
    if cfg.bitcoin_operator_key.is_empty() {
        return Err(anyhow!("BITCOIN_OPERATOR_KEY (WIF) is required for Hashi-path signing"));
    }
    let secp = Secp256k1::new();
    let wif: PrivateKey = cfg
        .bitcoin_operator_key
        .parse()
        .map_err(|e| anyhow!("Invalid WIF key: {}", e))?;
    let secret = wif.inner;
    let pk = secret.public_key(&secp);
    let mut pubkey = [0u8; 33];
    pubkey.copy_from_slice(&pk.serialize());
    info!("Signing with operator key, BTC pubkey: {}", hex::encode(pubkey));
    Ok(Box::new(OperatorSigner { secp, secret, pubkey }))
}
