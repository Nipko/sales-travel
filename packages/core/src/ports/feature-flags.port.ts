export interface FeatureFlagContext {
  tenantId: string;
  userId?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface FeatureFlagsPort {
  isEnabled(flag: string, context: FeatureFlagContext): Promise<boolean>;
  getVariant(flag: string, context: FeatureFlagContext): Promise<string | null>;
}
