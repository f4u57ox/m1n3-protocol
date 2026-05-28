/// Difficulty adjustment — VARDIFF-style algorithm mirroring Stratum's adaptive difficulty.
module m1n3_protocol::difficulty {

    // Target: 1 share per TARGET_INTERVAL_SEC seconds.
    const TARGET_INTERVAL_SEC: u64 = 10;
    const MIN_DIFFICULTY: u64 = 256;
    const MAX_DIFFICULTY: u64 = 0xFFFF_FFFF_FFFF;
    /// Clamp adjustment to ±4x per retarget.
    const MAX_RETARGET_FACTOR: u64 = 4;

    public struct DifficultyState has store, drop {
        current: u64,
        last_retarget_epoch: u64,
        shares_since_retarget: u64,
    }

    public fun new(initial: u64, epoch: u64): DifficultyState {
        DifficultyState {
            current: clamp(initial),
            last_retarget_epoch: epoch,
            shares_since_retarget: 0,
        }
    }

    public fun record_share(state: &mut DifficultyState) {
        state.shares_since_retarget = state.shares_since_retarget + 1;
    }

    /// Called each epoch; returns new difficulty. Mirrors VARDIFF retarget logic.
    public fun retarget(state: &mut DifficultyState, current_epoch: u64): u64 {
        let elapsed = current_epoch - state.last_retarget_epoch;
        if (elapsed == 0) return state.current;

        let expected_shares = elapsed * TARGET_INTERVAL_SEC;
        let actual = state.shares_since_retarget;

        let new_diff = if (actual == 0) {
            // No shares — ease difficulty down.
            state.current / 2
        } else {
            // Scale: new_diff = current * (actual / expected).
            // Multiply first to preserve precision.
            let scaled = (state.current as u128) * (actual as u128) / (expected_shares as u128);
            (scaled as u64)
        };

        // Clamp retarget to ±4x.
        let new_diff = if (new_diff > state.current * MAX_RETARGET_FACTOR) {
            state.current * MAX_RETARGET_FACTOR
        } else if (new_diff < state.current / MAX_RETARGET_FACTOR) {
            state.current / MAX_RETARGET_FACTOR
        } else {
            new_diff
        };

        let new_diff = clamp(new_diff);
        state.current = new_diff;
        state.last_retarget_epoch = current_epoch;
        state.shares_since_retarget = 0;
        new_diff
    }

    public fun current(state: &DifficultyState): u64 { state.current }

    fun clamp(v: u64): u64 {
        if (v < MIN_DIFFICULTY) MIN_DIFFICULTY
        else if (v > MAX_DIFFICULTY) MAX_DIFFICULTY
        else v
    }
}
