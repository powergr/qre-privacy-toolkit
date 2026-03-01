// --- START OF FILE entropy.rs ---

// ==========================================
// --- MODULE CONFIGURATION ---
// ==========================================
// This attribute tells the Rust compiler not to throw warnings if this function
// isn't currently called by the main Tauri GUI workflow. It exists primarily for
// CLI-based recovery tools, headless environments, or future "Paranoid Mode" GUI integrations.
#![allow(dead_code)]

use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

// ==========================================
// --- ENTROPY COLLECTION LOGIC ---
// ==========================================

/// Collects additional randomness (entropy) from the user via the command line.
///
/// SECURITY CONCEPT (Entropy Mixing / Defense-in-Depth):
/// If a system's native random number generator (CSPRNG) is backdoored or lacks entropy
/// (common on freshly booted embedded devices or certain VMs), encryption keys generated
/// from it can be predicted.
///
/// This function acts as a "Paranoid Mode" fallback, mixing three mathematically distinct
/// sources of unpredictability to generate a cryptographically secure 32-byte seed:
/// 1. **System Randomness:** The OS's native secure random number generator (`/dev/urandom` or `BCryptGenRandom`).
/// 2. **User Input:** Unpredictable keyboard mashing provided by the human user.
/// 3. **High-Precision Time:** The exact nanosecond timestamp of execution.
pub fn collect_user_entropy() -> [u8; 32] {
    println!("--- ENTROPY COLLECTION ---");
    println!("Please mash your keyboard randomly for a few seconds and hit ENTER: ");
    print!("> ");
    io::stdout().flush().unwrap();

    // 1. Capture User Input (Human Entropy)
    // Humans are terrible at true randomness, but the *combination* of keys pressed,
    // the length of the string, and the exact physical timing of when they hit ENTER
    // adds valuable physical jitter to our pool.
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .expect("Failed to read line");

    // 2. Capture Temporal Entropy (Time Jitter)
    // Grabs the current system time down to the exact nanosecond.
    // Because the execution time depends on CPU scheduling, memory latency, and exactly
    // when the user hit ENTER, this value is effectively unpredictable to an outside observer.
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    let nanos = since_the_epoch.as_nanos().to_le_bytes();

    // 3. Capture OS Randomness (Baseline Cryptographic Security)
    // Generates 32 bytes from the operating system's CSPRNG.
    // This is our safety net. If the user just hits "ENTER" immediately without mashing keys,
    // this ensures the resulting seed is still fully cryptographically secure under normal OS conditions.
    let mut os_entropy = [0u8; 32];
    OsRng.fill_bytes(&mut os_entropy);

    // 4. Mix Sources (Entropy Extraction)
    // We use SHA-256 as an entropy extractor/mixing function.
    // Cryptographic hashes exhibit the "Avalanche Effect"—changing even a single bit of input
    // completely changes the output. By hashing all three sources together, we guarantee that
    // as long as AT LEAST ONE of the three sources is secure, the final 32-byte output is secure.
    let mut hasher = Sha256::new();
    hasher.update(&os_entropy); // Primary source: OS Randomness
    hasher.update(input.as_bytes()); // Secondary source: Human Keyboard Jitter
    hasher.update(&nanos); // Tertiary source: Nanosecond Time Jitter

    let result = hasher.finalize();
    println!("Entropy mixed successfully.");

    // Return the final 32-byte array (256 bits), perfect for seeding a ChaCha20 RNG or deriving an AES key.
    result.into()
}

// --- END OF FILE entropy.rs ---
