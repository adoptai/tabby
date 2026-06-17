export function resolveTenantScope(user: { role: string; tenant_id: string }): string | undefined {
  return user.role === 'Admin' ? undefined : user.tenant_id;
}
