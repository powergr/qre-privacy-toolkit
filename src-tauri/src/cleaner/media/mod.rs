// --- START OF FILE cleaner/media/mod.rs ---
//
// Audio/video metadata handlers, split by format family: MP3 (ID3 +
// APEv2), FLAC/OGG/Opus/Speex (shared Vorbis-comment handling, including
// FLAC's native PICTURE metadata block), and MP4/MOV.

mod mp3;
mod vorbis;
mod mp4;

pub(super) use mp3::{analyze_mp3, strip_mp3};
pub(super) use vorbis::{analyze_flac, analyze_ogg, strip_flac, strip_ogg};
pub(super) use mp4::{analyze_mp4, strip_mp4};

// --- END OF FILE cleaner/media/mod.rs ---
