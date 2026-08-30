use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CoordinatorError {
    AlreadyInitialized = 800,
    NotInitialized = 801,
    Unauthorized = 802,

    // Workflow state errors
    WorkflowNotFound = 810,
    WorkflowAlreadyStarted = 811,
    InvalidWorkflowState = 812,
    CannotRollbackSettled = 813,
    AlreadyDone = 814,
    WorkflowNotExpired = 815,

    // Cross-contract pre-condition failures
    RequestNotFound = 820,
    InvalidRequestState = 821,
    UnitNotFound = 822,
    UnitNotAvailable = 823,
    PaymentNotFound = 824,
    InvalidPaymentState = 825,
    DeliveryNotConfirmed = 826,

    // Blood-type compatibility
    IncompatibleBloodType = 828,

    // Cross-contract call failures
    InventoryUpdateFailed = 830,
    PaymentUpdateFailed = 831,
    PaymentFlagFailed = 832,

    // Admin wiring
    InventoryAdminMismatch = 833,

    // Circuit breaker
    ContractPaused = 840,
    /// The requested pause flag name is not recognised.
    UnknownPauseFlag = 841,

    // Upgrade lifecycle (#31)
    MigrationAlreadyApplied = 850,
    UpgradeAlreadyPending = 851,
    NoPendingUpgrade = 852,
    TimelockNotElapsed = 853,
    /// A domain contract reports a code version outside the supported range.
    IncompatibleContractVersion = 854,
}
