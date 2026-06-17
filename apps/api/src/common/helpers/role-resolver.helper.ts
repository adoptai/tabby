import { IdentityProviderEntity } from '../../entities/identity-provider.entity';

export function resolveRoleFromIdp(
  idp: IdentityProviderEntity,
  verifiedPayload: Record<string, unknown>,
  email: string,
): string {
  // 1. Check source JWT role claim mapping
  if (idp.role_claim) {
    const sourceRoles: string[] = Array.isArray(verifiedPayload[idp.role_claim])
      ? (verifiedPayload[idp.role_claim] as string[])
      : [];
    if (idp.admin_role_values?.some(v => sourceRoles.includes(v))) {
      return 'Admin';
    }
    if (idp.editor_role_values?.some(v => sourceRoles.includes(v))) {
      return 'Editor';
    }
  }
  // 2. Fallback to admin_domains
  const emailDomain = email.split('@')[1] || '';
  if (idp.admin_domains?.length && emailDomain && idp.admin_domains.includes(emailDomain)) {
    return 'Admin';
  }
  // 3. Default
  return idp.default_role || 'Operator';
}
