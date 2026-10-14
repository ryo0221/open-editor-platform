/** Host-owned deterministic client. No UI, model/provider or instruction execution. */
import {
  prepareInstantiation,
  validateInputs,
  TemplateError,
  type TemplateCatalog,
} from '@editor-platform/templates';
export async function prepareAgentTemplate(
  catalog: TemplateCatalog,
  request: {
    templateId: string;
    templateVersion: number;
    inputs: unknown;
    requestId: string;
  },
) {
  const definition = await catalog.describe(request.templateId, request.templateVersion);
  const validation = validateInputs(definition.inputs, request.inputs);
  if (!validation.valid)
    throw new TemplateError(
      'invalid-input',
      'Agent inputs need correction',
      validation.diagnostics,
    );
  return prepareInstantiation(definition, validation.values, request.requestId);
}
