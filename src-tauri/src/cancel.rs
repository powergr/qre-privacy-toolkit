//! Stopping a long job from the window.
//!
//! Locking a 15 GB folder takes a long time, and the user must be able to stop it. The window asks
//! with the `cancel_operation` command, which raises a flag. The long steps (zipping a folder,
//! sealing or opening each 1 MiB chunk, and the gap between two files of a batch) look at the flag
//! and stop with the message [CANCELLED]. Everything they were writing is removed on the way out,
//! as it is for any other failure, so a cancelled job never leaves a half-made file behind.
//!
//! The flag belongs to the one job that is running. The job's thread is given the flag with
//! [run_with], and code deep inside asks [is_cancelled], so the flag does not have to be passed
//! through every function. A thread that was never given a flag is never cancelled, which is the
//! case for every test that does not ask for it, and for jobs that run in parallel with a job
//! that is cancelled.

use anyhow::{anyhow, Result};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The message of a cancelled job. The window recognises it by the word "Cancelled".
pub const CANCELLED: &str = "Cancelled.";

/// The flag shared between the window's cancel button and the job.
pub type CancelFlag = Arc<AtomicBool>;

thread_local! {
    static CURRENT: RefCell<Option<CancelFlag>> = const { RefCell::new(None) };
}

pub fn new_flag() -> CancelFlag {
    Arc::new(AtomicBool::new(false))
}

/// Asks the running job to stop at its next step.
pub fn request(flag: &CancelFlag) {
    flag.store(true, Ordering::SeqCst);
}

/// Clears the flag before a new job starts, so a cancel meant for the last job does not stop it.
pub fn reset(flag: &CancelFlag) {
    flag.store(false, Ordering::SeqCst);
}

/// Puts the previous flag back when the job ends, even if it panics.
struct Restore(Option<CancelFlag>);

impl Drop for Restore {
    fn drop(&mut self) {
        let previous = self.0.take();
        CURRENT.with(|c| *c.borrow_mut() = previous);
    }
}

/// Runs `work` with `flag` as the flag of the current thread.
pub fn run_with<T>(flag: &CancelFlag, work: impl FnOnce() -> T) -> T {
    let previous = CURRENT.with(|c| c.borrow_mut().replace(flag.clone()));
    let _restore = Restore(previous);
    work()
}

/// True if the job on this thread has been asked to stop.
pub fn is_cancelled() -> bool {
    CURRENT.with(|c| c.borrow().as_ref().is_some_and(|f| f.load(Ordering::SeqCst)))
}

/// `Err(CANCELLED)` if the job has been asked to stop. Called between steps.
pub fn check() -> Result<()> {
    if is_cancelled() {
        Err(anyhow!(CANCELLED))
    } else {
        Ok(())
    }
}

/// True if this error is the one `check` gives.
pub fn is_cancel_error(error: &anyhow::Error) -> bool {
    error.to_string() == CANCELLED
}
