import type { DetectorFailureMode } from '../../../config/pii.config';
import { CUSTOM_ENTITY_TYPE, needsNer } from './entity-catalogue';
import type { MaskingPolicy } from './masking-session';
import { BUILT_IN_RECOGNIZERS, CustomTermsRecognizer } from './recognizers';

/** The policy in force for one workspace: its saved policy, or the platform defaults. */
export interface EffectivePiiPolicy {
  organizationId: string;
  enabled: boolean;
  /** Sorted and unique. Includes `CUSTOM` exactly when the deny list is non-empty. */
  entityTypes: string[];
  scoreThreshold: number;
  onDetectorFailure: DetectorFailureMode;
  language: string;
  allowList: string[];
  denyList: string[];
  source: 'default' | 'workspace';
  version: number;
  updatedAt: Date | null;
}

/**
 * Normalises a requested type list: upper-case, unique, sorted, and with
 * `CUSTOM` present exactly when there are deny-list terms to match — a term
 * list that silently masked nothing because `CUSTOM` was left unticked would be
 * a trap.
 */
export function normalizeEntityTypes(
  types: readonly string[],
  denyList: readonly string[],
): string[] {
  const set = new Set(types.map((type) => type.trim().toUpperCase()).filter(Boolean));
  if (denyList.length > 0) set.add(CUSTOM_ENTITY_TYPE);
  else set.delete(CUSTOM_ENTITY_TYPE);
  return [...set].sort();
}

/** Types in the policy that only the NER model can find. */
export function nerTypesOf(policy: Pick<EffectivePiiPolicy, 'entityTypes'>): string[] {
  return policy.entityTypes.filter((type) => needsNer(type) && type !== CUSTOM_ENTITY_TYPE);
}

/** What a masking session applies under this policy. */
export function maskingPolicyFor(policy: EffectivePiiPolicy): MaskingPolicy {
  const recognizers =
    policy.denyList.length > 0
      ? [...BUILT_IN_RECOGNIZERS, new CustomTermsRecognizer(policy.denyList)]
      : BUILT_IN_RECOGNIZERS;

  return {
    enabledTypes: new Set(policy.entityTypes),
    scoreThreshold: policy.scoreThreshold,
    allowList: policy.allowList,
    recognizers,
  };
}

/** A short stable description of the policy, for cache keys and audit records. */
export function policyFingerprint(policy: EffectivePiiPolicy): string {
  return [
    policy.language,
    policy.scoreThreshold.toFixed(3),
    policy.entityTypes.join(','),
  ].join('|');
}
