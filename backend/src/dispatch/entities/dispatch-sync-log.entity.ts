import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SyncActionType {
  ACCEPT_ASSIGNMENT = 'accept_assignment',
  CONFIRM_PICKUP = 'confirm_pickup',
  CONFIRM_DROPOFF = 'confirm_dropoff',
  CAPTURE_SIGNATURE = 'capture_signature',
  ATTACH_PHOTO_REFERENCE = 'attach_photo_reference',
}

export enum SyncLogStatus {
  PROCESSED = 'processed',
  DUPLICATE = 'duplicate',
  CONFLICT = 'conflict',
}

@Entity('dispatch_sync_logs')
export class DispatchSyncLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 36, unique: true })
  idempotencyKey: string;

  @Column({ name: 'action_type', type: 'simple-enum', enum: SyncActionType })
  actionType: SyncActionType;

  @Column({ name: 'assignment_id', type: 'varchar' })
  assignmentId: string;

  @Column({ name: 'rider_id', type: 'varchar' })
  riderId: string;

  @Column({ name: 'captured_at', type: 'timestamptz' })
  capturedAt: Date;

  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;

  @Column({ name: 'late_sync', type: 'boolean', default: false })
  lateSync: boolean;

  @Column({ name: 'status', type: 'simple-enum', enum: SyncLogStatus })
  status: SyncLogStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
