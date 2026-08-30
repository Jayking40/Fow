export enum CustodyActor {
  BLOOD_BANK = 'blood_bank',
  RIDER = 'rider',
  HOSPITAL = 'hospital',
}

export enum CustodyHandoffStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
}

/**
 * On-chain backing state of a custody handoff, tracked independently of the
 * business `CustodyHandoffStatus` lifecycle. A handoff is only trustworthy as
 * proof of custody once its transfer has been observed on-chain by the indexer
 * (`VERIFIED`). On-chain failures are recorded explicitly (`FAILED`) instead of
 * being silently masked as a normal pending handoff.
 */
export enum CustodyChainStatus {
  /** No on-chain transfer has been submitted yet. */
  NOT_SUBMITTED = 'not_submitted',
  /** Transfer submitted to Soroban; awaiting indexer confirmation. */
  SUBMITTED = 'submitted',
  /** Indexer has observed the matching `custody_transferred` event on-chain. */
  VERIFIED = 'verified',
  /** The on-chain transfer call failed — this handoff has no chain backing. */
  FAILED = 'failed',
}
