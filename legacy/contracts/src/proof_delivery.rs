//! # Delivery Proof Commitment Module
//!
//! Implements the on-chain proof-commitment system:
//!
//! - [`ProofCommitment`] — a Merkle-root commitment stored per workflow.
//! - [`CustodyChainLink`] — hash-linked custody handoff entries.
//! - [`SchemeRegistry`] — versioned Merkle scheme registry.
//! - [`ProofAmendment`] — supersede-only history of amended commitments.
//!
//! All write operations that mutate delivery state are in the
//! [`HealthChainContract`] `#[contractimpl]` blocks at the bottom of this
//! file, re-exported via `lib.rs`.

// Type-only module — all function implementations live in lib.rs.
// The allow attribute suppresses unused-import warnings for types
// that are imported for #[contracttype] macro expansion.
#[allow(unused_imports)]
use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Map, String, Symbol, Vec};

// ── Proof commitment status ───────────────────────────────────────────────────

/// Lifecycle state of a proof commitment.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProofCommitmentStatus {
    /// Courier has submitted bundle hash; awaiting facility confirmation.
    PendingFacility,
    /// Both parties have attested; proof is confirmed and settlement-eligible.
    Confirmed,
    /// Superseded by a newer commitment (amendment); kept for audit history.
    Superseded,
    /// Disputed — under arbitration review.
    Disputed,
}

// ── Core commitment type ──────────────────────────────────────────────────────

/// On-chain proof commitment anchoring a delivery bundle.
///
/// `bundle_hash` is the Merkle root of the off-chain bundle:
///   courier attestation ∥ facility signature ∥ QR custody scan chain ∥
///   temperature summary hash ∥ GPS trail digest.
///
/// On-chain stays small; everything is independently verifiable via
/// `verify_inclusion`.
#[contracttype]
#[derive(Clone)]
pub struct ProofCommitment {
    /// Sequential commitment ID (per contract).
    pub commitment_id: u64,
    /// Off-chain workflow/order identifier (hex string).
    pub workflow_id: String,
    /// Merkle root of the off-chain proof bundle (32-byte SHA-256).
    pub bundle_hash: BytesN<32>,
    /// Scheme version governing how the Merkle tree was built.
    pub scheme_version: u32,
    /// Address of the courier who submitted the commitment.
    pub courier: Address,
    /// Address of the receiving facility.
    pub facility: Address,
    /// Current lifecycle status.
    pub status: ProofCommitmentStatus,
    /// Ledger timestamp when courier submitted the commitment.
    pub submitted_at: u64,
    /// Ledger timestamp when facility confirmed (None until confirmed).
    pub confirmed_at: Option<u64>,
    /// Facility confirmation deadline (submitted_at + window).
    pub facility_deadline: u64,
    /// If superseded, points to the newer commitment ID.
    pub superseded_by: Option<u64>,
    /// Reason text when superseded (provided by submitter + arbiter).
    pub supersede_reason: Option<String>,
}

// ── Hash-linked custody chain ─────────────────────────────────────────────────

/// A single hash-linked custody handoff within a workflow.
///
/// The chain is: `prev_link_hash = SHA256(prev entry bytes)`.
/// Gaps or re-writes are detectable because every verifier can re-derive
/// each link hash from its predecessor.
#[contracttype]
#[derive(Clone)]
pub struct CustodyChainLink {
    /// Sequential index within the workflow (0 = first handoff).
    pub index: u32,
    /// Workflow this link belongs to.
    pub workflow_id: String,
    /// SHA-256 of the previous link's canonical bytes
    /// (zeroed 32 bytes for index 0 — genesis marker).
    pub prev_link_hash: BytesN<32>,
    /// SHA-256 of this link's payload (actor IDs ∥ timestamp ∥ actor type).
    pub link_hash: BytesN<32>,
    /// Custodian handing off.
    pub from_actor: Address,
    /// Custodian receiving.
    pub to_actor: Address,
    /// Ledger timestamp of the handoff.
    pub handoff_at: u64,
}

// ── Scheme registry ───────────────────────────────────────────────────────────

/// Describes a registered Merkle proof scheme version.
///
/// Stored in `PROOF_SCHEMES` so verifiers can look up leaf/node hashing
/// rules by version number without re-deploying the contract.
#[contracttype]
#[derive(Clone)]
pub struct SchemeEntry {
    /// Monotonically increasing version number.
    pub version: u32,
    /// Human-readable description of the hashing strategy.
    pub description: String,
    /// Whether this scheme version is still accepted for new submissions.
    pub active: bool,
    /// Ledger timestamp when this scheme was registered.
    pub registered_at: u64,
}

// ── Amendment record ──────────────────────────────────────────────────────────

/// Emitted when a confirmed proof is superseded.
/// Both the old and new commitment IDs are retained on-chain.
#[contracttype]
#[derive(Clone)]
pub struct ProofSupersededEvent {
    /// Commitment ID that was superseded.
    pub old_commitment_id: u64,
    /// New commitment ID that supersedes it.
    pub new_commitment_id: u64,
    /// Workflow identifier.
    pub workflow_id: String,
    /// Human-readable reason for the amendment.
    pub reason: String,
    /// Arbiter who approved the amendment (for high-value).
    pub arbiter: Address,
    /// Ledger timestamp of the supersession.
    pub superseded_at: u64,
}

// ── Dual-attestation events ───────────────────────────────────────────────────

/// Emitted when a courier submits a proof commitment.
#[contracttype]
#[derive(Clone)]
pub struct ProofSubmittedEvent {
    pub commitment_id: u64,
    pub workflow_id: String,
    pub bundle_hash: BytesN<32>,
    pub scheme_version: u32,
    pub courier: Address,
    pub facility: Address,
    pub submitted_at: u64,
    pub facility_deadline: u64,
}

/// Emitted when a facility confirms a proof commitment.
#[contracttype]
#[derive(Clone)]
pub struct ProofConfirmedEvent {
    pub commitment_id: u64,
    pub workflow_id: String,
    pub bundle_hash: BytesN<32>,
    pub facility: Address,
    pub confirmed_at: u64,
}

/// Emitted when a custody chain link is appended.
#[contracttype]
#[derive(Clone)]
pub struct CustodyLinkAppendedEvent {
    pub workflow_id: String,
    pub index: u32,
    pub link_hash: BytesN<32>,
    pub from_actor: Address,
    pub to_actor: Address,
    pub handoff_at: u64,
}

// ── Storage key variants for proof-delivery data ──────────────────────────────

/// Composite storage keys used by proof-delivery functions.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProofKey {
    /// Per-workflow ordered custody chain: workflow_id -> Vec<CustodyChainLink>
    CustodyChain(String),
    /// Per-workflow proof commitment history: workflow_id -> Vec<u64> (commitment IDs)
    WorkflowHistory(String),
}

/// Facility confirmation window in seconds (4 hours).
///
/// After a courier submits a commitment, the facility has this window to
/// confirm. Past this deadline the dispute escape hatch is available.
pub const FACILITY_CONFIRM_WINDOW_SECS: u64 = 4 * 3_600;
