#![allow(dead_code)] // Allows this module to be compiled even if specific functions aren't currently used.

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;

/// A wrapper around a Cryptographically Secure Pseudo-Random Number Generator (CSPRNG).
///
/// This implementation uses the ChaCha20 algorithm, which is:
/// 1. Fast (suitable for generating large amounts of data).
/// 2. Secure (resistant to prediction attacks).
/// 3. Deterministic (if seeded with the same value, it produces the same stream).
pub struct SecureEngine {
    rng: ChaCha20Rng,
}

impl SecureEngine {
    /// Initializes the engine with a specific 32-byte seed.
    ///
    /// This seed usually comes from the `entropy` module (mixing user mouse movements,
    /// system time, and OS randomness) to ensure the starting state is unpredictable.
    pub fn new(seed: [u8; 32]) -> Self {
        Self {
            rng: ChaCha20Rng::from_seed(seed),
        }
    }

    /// Fills a specific buffer with random bytes.
    ///
    /// This is the core function used to generate noise, salts, or initialization vectors (IVs).
    pub fn fill_bytes(&mut self, dest: &mut [u8]) {
        self.rng.fill_bytes(dest);
    }

    /// Helper function to generate a fresh 32-byte AES-256 key.
    ///
    /// This abstracts the process of creating a buffer and filling it, ensuring
    /// consistency whenever a new encryption key is needed.
    pub fn gen_aes_key(&mut self) -> [u8; 32] {
        let mut key = [0u8; 32];
        // Calls the internal helper method to populate the key.
        self.fill_bytes(&mut key);
        key
    }
}

// Ensures the RNG state is handled correctly when the object goes out of scope.
impl Drop for SecureEngine {
    fn drop(&mut self) {
        // The ChaCha20Rng implementation handles internal cleanup.
        // If this struct held raw sensitive seeds directly in fields,
        // explicit memory zeroing (wiping) would happen here to prevent RAM analysis attacks.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that the RNG is deterministic.
    /// In cryptography, it is critical that the same seed produces the exact same output stream.
    /// This allows for reproducible encryption keys if the user recovers their seed.
    #[test]
    fn test_prng_determinism() {
        let seed = [42u8; 32];
        let mut eng1 = SecureEngine::new(seed);
        let mut eng2 = SecureEngine::new(seed);

        let mut out1 = [0u8; 16];
        let mut out2 = [0u8; 16];

        eng1.fill_bytes(&mut out1);
        eng2.fill_bytes(&mut out2);

        assert_eq!(out1, out2);
    }

    /// Verifies that different seeds produce different outputs.
    /// This ensures that a small change in entropy results in a completely different key.
    #[test]
    fn test_prng_uniqueness() {
        let seed1 = [1u8; 32];
        let seed2 = [2u8; 32];

        let mut eng1 = SecureEngine::new(seed1);
        let mut eng2 = SecureEngine::new(seed2);

        let mut out1 = [0u8; 32];
        let mut out2 = [0u8; 32];

        eng1.fill_bytes(&mut out1);
        eng2.fill_bytes(&mut out2);

        assert_ne!(out1, out2);
    }
}