import { MetaModelProvider, MetaModelProviderOptions } from './MetaModelProvider';

export interface MetaSparkProviderOptions extends MetaModelProviderOptions {
  /**
   * Alias of `baseUrl` kept for cross-provider option compatibility.
   */
  endpoint?: string;
}

/**
 * Backward-compatible Meta Spark provider.
 * Phase 14.1 implementation lives in MetaModelProvider; this class preserves
 * the historic name, providerName, and constructor-option shape.
 */
export class MetaSparkProvider extends MetaModelProvider {
  public override readonly providerName = 'meta-spark';

  constructor(options?: MetaSparkProviderOptions) {
    const { endpoint, ...rest } = options ?? {};
    super({ ...rest, baseUrl: options?.baseUrl ?? endpoint });
  }
}
