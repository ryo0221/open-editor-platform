import { defineKind } from '@editor-platform/artifact-kinds';
import { isReactUiDocument, type ReactUiDocument } from '@editor-platform/react-ui-core';

/** The React UI kind. The Host supplies the registered components a new document starts with. */
export const reactUiKind = (starter: () => ReactUiDocument) =>
  defineKind<ReactUiDocument>({
    kind: 'react-ui',
    area: 'office',
    label: 'React UI',
    icon: '⚛',
    description: 'Compose original registered components',
    creatable: true,
    create: (count) => ({ name: `React UI ${count}`, content: starter() }),
    validate: isReactUiDocument,
  });
