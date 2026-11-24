import modelConfig from '../../../config/ai-models.cjs'

// The existing Voyage Vectorize index was built in this model's embedding space.
const VOYAGE_INDEX_MODEL = 'voyage-4-lite'
const selection = modelConfig?.features?.['search.embedding']

export const VOYAGE_EMBEDDING_MODEL =
  modelConfig?.schema_version === 1 &&
  selection?.profile === 'embedding.default' &&
  selection.provider === 'mongodb' &&
  selection.execution_mode === 'realtime' &&
  selection.api_model_id === VOYAGE_INDEX_MODEL
    ? selection.api_model_id
    : null

export function requireVoyageEmbeddingModel(): string {
  if (!VOYAGE_EMBEDDING_MODEL) {
    throw new Error(
      'The shared embedding policy is incompatible with the existing Voyage index. Rebuild the index and coordinate the model switch.',
    )
  }
  return VOYAGE_EMBEDDING_MODEL
}
