#[test_only]
module m1n3_protocol::pool_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin;
    use sui::sui::SUI;
    use std::string;
    use m1n3_protocol::pool::{Self, Pool};

    const OPERATOR: address = @0xCAFE;
    const WORKER_A: address = @0xA1;
    const WORKER_B: address = @0xB2;

    fun setup_pool(s: &mut Scenario) {
        ts::next_tx(s, OPERATOR);
        pool::create_pool(ts::ctx(s));
    }

    #[test]
    fun test_create_pool() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);
        ts::next_tx(&mut s, OPERATOR);
        let p = ts::take_shared<Pool>(&s);
        assert!(pool::difficulty(&p) > 0, 0);
        assert!(pool::total_shares(&p) == 0, 1);
        ts::return_shared(p);
        ts::end(s);
    }

    #[test]
    fun test_register_and_submit_share() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);

        // Post a job.
        ts::next_tx(&mut s, OPERATOR);
        {
            let mut p = ts::take_shared<Pool>(&s);
            let mut pay = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut s));
            pool::post_job(
                &mut p,
                x"0000000000000000000000000000000000000000000000000000000000000001",
                x"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
                x"ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000",
                vector::empty<vector<u8>>(),
                0x20000000u32,
                0x1d00ffffu32,
                0x4d49e5dau32,
                500_000_000,
                &mut pay,
                ts::ctx(&mut s),
            );
            ts::return_shared(p);
            transfer::public_transfer(pay, OPERATOR);
        };

        // Register worker A and submit a share.
        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(&mut p, string::utf8(b"worker_a.default"), ts::ctx(&mut s));
            pool::submit_share(&mut p, 0, 0xDEADBEEFu32, ts::ctx(&mut s));
            assert!(pool::worker_shares(&p, WORKER_A) == 1, 0);
            ts::return_shared(p);
        };

        ts::end(s);
    }

    #[test]
    fun test_claim_reward() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);

        ts::next_tx(&mut s, OPERATOR);
        {
            let mut p = ts::take_shared<Pool>(&s);
            let mut pay = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut s));
            pool::post_job(
                &mut p,
                x"0000000000000000000000000000000000000000000000000000000000000001",
                x"",
                x"",
                vector::empty<vector<u8>>(),
                1u32, 0x1d00ffffu32, 0u32,
                1_000_000_000,
                &mut pay,
                ts::ctx(&mut s),
            );
            ts::return_shared(p);
            transfer::public_transfer(pay, OPERATOR);
        };

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(&mut p, string::utf8(b"a"), ts::ctx(&mut s));
            pool::submit_share(&mut p, 0, 1u32, ts::ctx(&mut s));
            ts::return_shared(p);
        };

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::claim_reward(&mut p, ts::ctx(&mut s));
            assert!(pool::worker_shares(&p, WORKER_A) == 0, 0);
            ts::return_shared(p);
        };

        ts::end(s);
    }
}
