import type { Page } from '@playwright/test';
import { confirmed } from './practical-fixtures';
import { reuseHistory } from './reuse-fixtures';

/** Shared-history callers must finish confirmation before requesting native output. */
export async function reuseSharedHistory(page: Page, direction: 'Undo' | 'Redo') {
  await reuseHistory(page, direction);
  await confirmed(page);
}
