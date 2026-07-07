import { IdentityProviderEntity } from '../../entities/identity-provider.entity';

export function resolveRoleFromIdp(
  idp: IdentityProviderEntity,
  verifiedPayload: Record<string, unknown>,
  email: string,
): string {
  // 1. Check source JWT role claim mapping
  if (idp.role_claim) {
    const raw = verifiedPayload[idp.role_claim];
    const sourceRoles: string[] = Array.isArray(raw)
      ? raw.map((r: unknown) => typeof r === 'object' && r !== null && 'key' in r ? String((r as Record<string, unknown>).key) : String(r))
      : typeof raw === 'string' ? [raw]
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
