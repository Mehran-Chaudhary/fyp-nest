import { InitialSchema1758500000000 } from './1758500000000-InitialSchema';
import { KnowledgeLayer1758600000000 } from './1758600000000-KnowledgeLayer';
import { InferenceAgentsPrivacy1758700000000 } from './1758700000000-InferenceAgentsPrivacy';

/**
 * Migrations, in execution order.
 *
 * Listed explicitly rather than discovered by glob for the same reason as the
 * entity list: the pattern that resolves under ts-node does not resolve against
 * compiled output, and a migration that silently fails to load is far worse than
 * one that fails to compile.
 */
export const migrations = [
  InitialSchema1758500000000,
  KnowledgeLayer1758600000000,
  InferenceAgentsPrivacy1758700000000,
];
