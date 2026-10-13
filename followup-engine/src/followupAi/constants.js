// The four Follow-up AI jobs. The id is both the prompt id (ai_bots_config / aiPromptCatalog) and the billing runner,
// so every call is billed at the chat AI multiplier (see the migration, billing_runners).
export const BOTS = {
  author: 'followup_ai_author',
  director: 'followup_ai_director',
  writer: 'followup_ai_writer',
  qc: 'followup_ai_qc',
}
