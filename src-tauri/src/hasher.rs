use anyhow::Result;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

// Import the Digest trait which provides the update() and finalize() methods
// This works for Sha256, Sha1, and Md5 because they all use the same 'digest' crate now.
use sha2::Digest;

use md5::Md5;
use sha1::Sha1;
use sha2::Sha256; // 'md-5' crate exposes this module

#[derive(serde::Serialize)]
pub struct HashResult {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
}

pub fn calculate_hashes(path_str: &str) -> Result<HashResult> {
    let path = Path::new(path_str);
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);

    // Initialize all 3 hashers
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let mut buffer = [0; 8192]; // 8KB Buffer

    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let slice = &buffer[..count];

        // Update all hashers with the same chunk
        sha256.update(slice);
        sha1.update(slice);
        md5_hasher.update(slice);
    }

    Ok(HashResult {
        sha256: format!("{:x}", sha256.finalize()),
        sha1: format!("{:x}", sha1.finalize()),
        md5: format!("{:x}", md5_hasher.finalize()),
    })
}
