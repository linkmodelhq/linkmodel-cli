/**
 * Shared task status values and request/response types.
 *
 * Only fields shared by all modalities live here.
 * Modality-specific types, such as image quality or size, belong to each ModalitySpec implementation.
 */

export const TASK_STATUSES = ['Pending', 'Processing', 'Success', 'Failed', 'Cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** Statuses other than Pending and Processing are terminal. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'Success' || status === 'Failed' || status === 'Cancelled';
}

/** Create task response data shared by all modalities. */
export interface CreateTaskData {
  task_id: string;
  price?: number;
  [key: string]: unknown;
}

/**
 * Shared part of query task response data.
 * Artifact fields are parsed by ModalitySpec.
 */
export interface TaskStatusData {
  task_id?: string;
  status: TaskStatus;
  /** Task-level error details returned by the server for Failed tasks. */
  msg?: string;
  [key: string]: unknown;
}
