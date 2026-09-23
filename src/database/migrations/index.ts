import { InitialSchema1758500000000 } from './1758500000000-InitialSchema';

/**
 * Migrations, in execution order.
 *
 * Listed explicitly rather than discovered by glob for the same reason as the
 * entity list: the pattern that resolves under ts-node does not resolve against
 * compiled output, and a migration that silently fails to load is far worse than
 * one that fails to compile.
 */
export const migrations = [InitialSchema1758500000000];
