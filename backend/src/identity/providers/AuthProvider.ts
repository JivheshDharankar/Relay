import { AuthCredentials, AuthProviderType, AuthResult, ProviderMetadata, ProviderStatus } from '../types';

/**
 * Extensible Provider-Independent Authentication Contract.
 * Guarantees that authentication logic is decoupled from specific vendor SDKs.
 */
export interface AuthProvider {
  readonly providerName: AuthProviderType;
  readonly isConfigured: boolean;
  readonly status: ProviderStatus;

  /**
   * Returns public provider capability and availability metadata.
   */
  getMetadata(): ProviderMetadata;

  /**
   * Authenticates incoming credentials.
   * NEVER fakes OAuth success. If configuration is missing, explicitly reports
   * requiresConfig = true rather than simulating artificial authentication.
   */
  authenticate(credentials: AuthCredentials): Promise<AuthResult>;
}

