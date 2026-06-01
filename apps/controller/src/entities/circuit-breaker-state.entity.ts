import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Persistent circuit-breaker state shared across controller replicas.
 * Replaces the in-memory Maps in ReconcileService so all replicas see
 * the same pause state.
 */
@Entity('circuit_breaker_state')
export class CircuitBreakerStateEntity {
  /** 'app' or 'tenant' */
  @PrimaryColumn({ type: 'varchar', length: 50 })
  entity_type: string;

  /** app.id or tenant.id */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  entity_id: string;

  @Column({ type: 'timestamptz' })
  pause_until: Date;

  @Column({ type: 'integer', default: 0 })
  failure_count: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
