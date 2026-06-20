use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "operator-bot", about = "m1n3 pool operator automation bot")]
pub struct BotConfig {
    /// Sui RPC URL
    #[arg(long, env = "SUI_RPC_URL", default_value = "https://fullnode.devnet.sui.io:443")]
    pub sui_rpc_url: String,

    /// m1n3 Sui package ID (0x…)
    #[arg(long, env = "SUI_PACKAGE_ID")]
    pub package_id: String,

    /// Pool shared object ID (0x…)
    #[arg(long, env = "POOL_OBJECT_ID")]
    pub pool_object_id: String,

    /// PoolAdminCap owned-object ID held by the operator wallet.
    #[arg(long, env = "POOL_ADMIN_CAP_ID")]
    pub pool_admin_cap_id: String,

    /// HashiPoolConfig shared-object ID.
    #[arg(long, env = "HASHI_POOL_CONFIG_ID", default_value = "")]
    pub hashi_pool_config_id: String,

    /// HashiRewardRegistry shared-object ID.
    #[arg(long, env = "HASHI_REWARD_REGISTRY_ID", default_value = "")]
    pub hashi_reward_registry_id: String,

    /// HashiVault owned-object ID (or shared, depending on deploy choice).
    #[arg(long, env = "HASHI_VAULT_ID", default_value = "")]
    pub hashi_vault_id: String,

    /// Fully-qualified hBTC coin type used for HashiRewardBatch<CoinType>
    /// — e.g. `0xABC::btc::BTC` once Hashi is on mainnet, or a test type
    /// while developing.
    #[arg(long, env = "HBTC_COIN_TYPE", default_value = "0x2::sui::SUI")]
    pub hbtc_coin_type: String,

    /// Path to Sui operator keystore JSON (~/.sui/sui_config/sui.keystore)
    #[arg(long, env = "SUI_KEYSTORE_PATH", default_value = "~/.sui/sui_config/sui.keystore")]
    pub sui_keystore_path: String,

    /// Bitcoin Core RPC URL (e.g. http://user:pass@localhost:8332)
    #[arg(long, env = "BITCOIN_RPC_URL", default_value = "")]
    pub bitcoin_rpc_url: String,

    /// Bitcoin operator private key in WIF format for signing payout transactions.
    #[arg(long, env = "BITCOIN_OPERATOR_KEY", default_value = "")]
    pub bitcoin_operator_key: String,

    /// Gas budget per Sui transaction (MIST)
    #[arg(long, env = "GAS_BUDGET", default_value = "100000000")]
    pub gas_budget: u64,

    /// Seconds between pool state polls
    #[arg(long, env = "POLL_INTERVAL_SECS", default_value = "10")]
    pub poll_interval_secs: u64,

    /// Number of Bitcoin confirmations before marking a payout confirmed
    #[arg(long, env = "BTC_CONFIRMATIONS_REQUIRED", default_value = "3")]
    pub btc_confirmations_required: u32,

    /// Satoshis to pay out per round (total block reward minus fees).
    /// If 0 the bot reads it from the coinbase transaction value.
    #[arg(long, env = "ROUND_TOTAL_SATS", default_value = "0")]
    pub round_total_sats: u64,

    /// Claim window in milliseconds — passed to hashi_rewards::fund_batch.
    #[arg(long, env = "CLAIM_WINDOW_MS", default_value = "604800000")] // 7 days
    pub claim_window_ms: u64,

    /// Hashi bridge mode:
    ///   `stub`  — operator-bot emits hashi_pool events and uses
    ///            mark_hashi_approved/_confirmed itself; no real bridge.
    ///            Used for devnet demos until Hashi exposes its package ID.
    ///   `real`  — operator-bot calls hashi::deposit::deposit etc. directly.
    ///            Requires HASHI_PACKAGE_ID + HASHI_OBJECT_ID below.
    #[arg(long, env = "HASHI_MODE", default_value = "stub")]
    pub hashi_mode: String,

    /// Hashi package ID (only needed if hashi_mode = real).
    #[arg(long, env = "HASHI_PACKAGE_ID", default_value = "")]
    pub hashi_package_id: String,

    /// Hashi shared-object ID (only needed if hashi_mode = real).
    #[arg(long, env = "HASHI_OBJECT_ID", default_value = "")]
    pub hashi_object_id: String,
}
