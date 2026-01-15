#![allow(dead_code)] // Allows this module to exist even if not currently used by the main GUI workflow.

use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// Collects additional randomness (entropy) from the user via the command line.
///
/// This function acts as a "Paranoid Mode" for CLI operations, mixing three distinct
/// sources of unpredictability to generate a cryptographically secure seed:
/// 1. **System Randomness:** The OS's native secure random number generator.
/// 2. **User Input:** Unpredictable keyboard mashing provided by the human user.
/// 3. **High-Precision Time:** The exact nanosecond timestamp of execution.
pub fn collect_user_entropy() -> [u8; 32] {
    println!("--- ENTROPY COLLECTION ---");
    println!("Please mash your keyboard randomly for a few seconds and hit ENTER: ");
    print!("> ");
    io::stdout().flush().unwrap();

    // 1. Capture User Input
    // The specific keys pressed and the length of input provide human-based randomness.
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .expect("Failed to read line");

    // 2. Capture Time Source
    // Uses the current system time down to the nanosecond.
    // This value changes constantly, adding a temporal element to the seed.
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    let nanos = since_the_epoch.as_nanos().to_le_bytes();

    // 3. Capture OS Randomness
    // Generates 32 bytes from the operating system's CSPRNG (Cryptographically Secure Pseudo-Random Number Generator).
    // This ensures that even if user input is weak (e.g., just pressing "Enter"), the result remains secure.
    let mut os_entropy = [0u8; 32];
    OsRng.fill_bytes(&mut os_entropy);

    // 4. Mix Sources
    // Uses SHA-256 to hash all three sources together.
    // The result is a single 32-byte array that depends on all inputs.
    let mut hasher = Sha256::new();
    hasher.update(&os_entropy);      // Base Security
    hasher.update(input.as_bytes()); // Human Jitter
    hasher.update(&nanos);           // Time Jitter

    let result = hasher.finalize();
    println!("Entropy mixed successfully.");
    
    // Return the final seed
    result.into()
}