//! Versioned remote filesystem mutation contracts and decision logic.
//!
//! Transport access belongs in the I/O adapter. In particular, this module
//! consumes the shared [`SessionBindingV1`] contract and never maintains a
//! second session/generation registry.

pub mod commands;
pub mod metadata;
mod model;

pub use model::*;
