#[test_only]
module m1n3_v4::hashi_vault_tests {
    use sui::coin;
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use sui::transfer;
    use m1n3_v4::pool::{Self, PoolAdminCap};
    use m1n3_v4::hashi_vault::{Self, HashiVault};

    /// Stand-in BTC type for tests; in production this is hashi::btc::BTC.
    public struct TBTC has drop {}

    const ADMIN: address = @0xA1;

    fun init_test_scenario(scenario: &mut ts::Scenario) {
        pool::init_for_testing(ts::ctx(scenario));
    }

    /// `create_shared` is the only constructor after the trustless cleanup —
    /// owned vaults are gone (they couldn't participate in the permissionless
    /// funding path anyway). Vault is taken from the shared pool.
    #[test]
    fun creates_shared_vault() {
        let mut sc = ts::begin(ADMIN);
        init_test_scenario(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        let cap = ts::take_from_sender<PoolAdminCap>(&sc);
        hashi_vault::create_shared<TBTC>(&cap, ts::ctx(&mut sc));
        ts::return_to_sender(&sc, cap);

        ts::next_tx(&mut sc, ADMIN);
        let v = ts::take_shared<HashiVault<TBTC>>(&sc);
        assert!(hashi_vault::hbtc_balance(&v) == 0, 0);
        assert!(hashi_vault::sui_balance(&v) == 0, 0);
        assert!(hashi_vault::derivation_path(&v) != @0x0, 0);
        ts::return_shared(v);
        ts::end(sc);
    }

    /// TTO path still works against a shared vault.
    #[test]
    fun receive_hbtc_via_transfer_to_object() {
        let mut sc = ts::begin(ADMIN);
        init_test_scenario(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        let cap = ts::take_from_sender<PoolAdminCap>(&sc);
        hashi_vault::create_shared<TBTC>(&cap, ts::ctx(&mut sc));
        ts::return_to_sender(&sc, cap);

        ts::next_tx(&mut sc, ADMIN);
        let vault_id = ts::most_recent_id_shared<HashiVault<TBTC>>().extract();
        let vault_addr: address = vault_id.id_to_address();
        let coin = coin::mint_for_testing<TBTC>(800_000_000, ts::ctx(&mut sc));
        transfer::public_transfer(coin, vault_addr);

        ts::next_tx(&mut sc, ADMIN);
        let mut v = ts::take_shared<HashiVault<TBTC>>(&sc);
        let receiving = ts::most_recent_receiving_ticket<coin::Coin<TBTC>>(&vault_id);
        hashi_vault::receive_hbtc(&mut v, receiving);
        assert!(hashi_vault::hbtc_balance(&v) == 800_000_000, 0);
        assert!(hashi_vault::lifetime_received_hbtc(&v) == 800_000_000, 0);
        ts::return_shared(v);
        ts::end(sc);
    }

    /// SUI accumulator path stays as a no-withdraw inbound channel. The
    /// trustless cleanup removed `withdraw_sui` — SUI lands in the vault
    /// and stays there until a future trustless drain path exists.
    #[test]
    fun receive_sui_path() {
        let mut sc = ts::begin(ADMIN);
        init_test_scenario(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        let cap = ts::take_from_sender<PoolAdminCap>(&sc);
        hashi_vault::create_shared<TBTC>(&cap, ts::ctx(&mut sc));
        ts::return_to_sender(&sc, cap);

        ts::next_tx(&mut sc, ADMIN);
        let vault_id = ts::most_recent_id_shared<HashiVault<TBTC>>().extract();
        let vault_addr: address = vault_id.id_to_address();
        let sui_coin = coin::mint_for_testing<SUI>(5_000_000_000, ts::ctx(&mut sc));
        transfer::public_transfer(sui_coin, vault_addr);

        ts::next_tx(&mut sc, ADMIN);
        let mut v = ts::take_shared<HashiVault<TBTC>>(&sc);
        let receiving = ts::most_recent_receiving_ticket<coin::Coin<SUI>>(&vault_id);
        hashi_vault::receive_sui(&mut v, receiving);
        assert!(hashi_vault::sui_balance(&v) == 5_000_000_000, 0);
        ts::return_shared(v);
        ts::end(sc);
    }
}
