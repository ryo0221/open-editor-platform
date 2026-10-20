import { test } from './fixtures';
import {
  editNestedText,
  editPrimitiveTextFromInspector,
  assertPrimitiveLocks,
  assertCompositeStyleLocks,
  assertStyledHiddenGeometry,
} from './design-instance-text-fixtures';

test('#27 mobile styled hidden elements stay outside canvas and export geometry', async ({
  page,
}, info) => {
  await assertStyledHiddenGeometry(page, info);
});

test('#27 nested Design text on a narrow independent Host', async ({ page }, info) => {
  await editNestedText(page, info);
});

test('#27 mobile primitive canvas edits remain editable from Inspector after reload', async ({
  page,
}, info) => {
  await editPrimitiveTextFromInspector(page, info);
});

test('#27 mobile primitive shared and root locks prevent opening a text editor', async ({
  page,
}, info) => {
  await assertPrimitiveLocks(page, info);
});

test('#27 mobile composite shared styles hide descendants and prevent locked text input', async ({
  page,
}, info) => {
  await assertCompositeStyleLocks(page, info);
});
