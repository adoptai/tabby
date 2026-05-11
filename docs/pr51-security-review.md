# PR #51 — Security Review: OAuth and Email Gate for VNC Session Access

10 changed files, 529 additions, 33 deletions.

---

## Critical

### C-1 — Email gate bypass: qualquer user do mesmo tenant acessa sessao alheia

**Arquivo:** `apps/api/src/modules/streaming/streaming.controller.ts` — linhas 523-537

**Problema:**
Quando `owner_user_id` eh um sub federado (ex: `google|abc123`), a busca `findOne({ id: session.owner_user_id })` retorna `null` porque nao existe user local com esse ID. O fallback na linha 531 busca **qualquer** user do mesmo tenant com o email informado:

```typescript
const tenantUser = await this.userRepo.findOne({
  where: { tenant_id: session.tenant_id, email },
});
if (tenantUser) {
  matchedUserId = tenantUser.id; // <-- qualquer user do tenant serve
}
```

O cookie emitido na linha 547 usa `owner_user_id: session.owner_user_id`, entao o atacante ganha acesso total a sessao.

**Cenarios de exploracao:**
1. `allow_auto_provision = false` — user federado nunca tem row local. Qualquer email de tenant member funciona.
2. `allow_auto_provision = true` mas primeira autenticacao — race window entre criacao da sessao e primeiro OAuth login. Row auto-provisionada ainda nao existe.
3. Catch silencioso em `auth.controller.ts:617` falha por motivo diferente de race — row nao eh criada, fallback ativado.

**Como arrumar:**

Remover o fallback de tenant inteiro. O email gate deve validar que o email pertence ao `owner_user_id` da sessao, nao a qualquer user do tenant.

```typescript
// Opção A: buscar user pelo owner_user_id E comparar email
const ownerUser = await this.userRepo.findOne({ where: { id: session.owner_user_id } });
if (!ownerUser || ownerUser.email?.toLowerCase() !== email) {
  throw new ForbiddenException('Email does not match session owner');
}
const matchedUserId = ownerUser.id;
```

Para users federados cujo `owner_user_id` eh um sub externo (nao UUID local), o user deve ter sido auto-provisionado antes. Se nao foi, o email gate simplesmente nao funciona — e isso eh o comportamento correto (forca OAuth).

**O que pode quebrar:**
- Sessoes de users federados que ainda nao fizeram OAuth login (row nao existe) vao ver "Email does not match" no email gate. **Isso eh desejavel** — forca o user a autenticar via OAuth, que eh o caminho seguro.
- Se `allow_auto_provision = false` no IdP, o email gate nunca vai funcionar pra users federados. Documentar que email gate requer auto-provision OU que o user ja tenha row local.

---

### C-2 — WebSocket gate eh opcional: stream token sozinho bypassa todo o OAuth/email wall

**Arquivo:** `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts` — linhas 98-117

**Problema:**
O WS upgrade permite conexao **sem** `tabby_vnc` cookie — o stream token sozinho eh suficiente:

```typescript
// Defense-in-depth: if a tabby_vnc cookie is present, validate it.
// Absent cookie is allowed (stream token alone is sufficient for backward compat).
if (session.owner_user_id) {
  const vncCookie = this.parseVncCookie(cookieHeader);
  if (vncCookie !== null) { // <-- null = sem cookie = permitido
    // ... valida ...
  }
}
```

Quem obtiver o stream token (Slack messages, logs, browser history, Referer header) conecta diretamente ao VNC backend sem OAuth. O auth gate HTTP vira feature de UX, nao controle de seguranca.

**Como arrumar:**

Tornar o cookie obrigatorio quando a sessao tem `owner_user_id`:

```typescript
if (session.owner_user_id) {
  const vncCookie = this.parseVncCookie(cookieHeader);
  if (!vncCookie) {
    this.rejectUpgrade(clientSocket, 401, 'VNC access cookie required');
    return;
  }
  try {
    const vncPayload = this.jwtService.verify<{ owner_user_id: string; type: string }>(vncCookie);
    if (vncPayload.type !== 'vnc_access' || vncPayload.owner_user_id !== session.owner_user_id) {
      this.rejectUpgrade(clientSocket, 401, 'VNC cookie owner mismatch');
      return;
    }
  } catch {
    this.rejectUpgrade(clientSocket, 401, 'Invalid VNC access cookie');
    return;
  }
}
```

**O que pode quebrar:**
- **MCP/python-mcp flow:** o python-mcp gera short links com stream token e os passa pro LLM. Se o LLM (ou browser do user) tenta abrir o WebSocket sem ter passado pelo OAuth flow antes, a conexao eh rejeitada. O fluxo precisa garantir que o browser faz o HTTP GET (que seta o cookie via OAuth) antes de abrir o WS.
- **API callers diretos** (service-to-service com stream token): se algum servico abre WS sem cookie, vai quebrar. Revisar se existe algum consumer que conecta direto ao WS sem passar pelo viewer HTML. Se sim, aceitar tambem `Authorization: Bearer <tabby-jwt>` no WS upgrade como alternativa ao cookie.
- **Sessoes sem `owner_user_id`**: nao afetadas — o `if (session.owner_user_id)` ja isola.

---

## High

### H-1 — Redis state: crypto.randomUUID() vs crypto.randomBytes()

**Arquivo:** `apps/api/src/modules/auth/auth.controller.ts` — linha 460

**Problema:**
`crypto.randomUUID()` tem 122 bits de entropia (UUID v4) — aceitavel na pratica, mas `crypto.randomBytes` eh preferido pra auditoria de seguranca. Mais importante: confirmar que o state value nunca aparece em logs (request logs, error logs, etc), ja que o payload no Redis contem `codeVerifier` (PKCE).

**Como arrumar:**

```typescript
const state = crypto.randomBytes(32).toString('hex'); // 256 bits
```

**O que pode quebrar:** Nada. O state eh opaque pra todos os consumers.

---

### H-2 — Auto-provision silencia TODOS os erros

**Arquivo:** `apps/api/src/modules/auth/auth.controller.ts` — linha 617

**Problema:**
```typescript
} catch { /* duplicate key race — ignore */ }
```

Qualquer erro (schema mismatch, constraint violation nao-race, outage de DB) eh engolido. Se a row nao eh criada, o email gate fallback (C-1) fica exposto. Comparar com `token-exchange.service.ts` que loga warning.

**Como arrumar:**

```typescript
} catch (err: any) {
  if (err?.code !== '23505') { // Postgres duplicate key
    this.logger.warn(`Auto-provision user failed: ${err?.message}`, { userId, email });
  }
}
```

**O que pode quebrar:** Nada. Apenas adiciona logging.

---

### H-3 — OAuth error param refletido verbatim na resposta

**Arquivo:** `apps/api/src/modules/auth/auth.controller.ts` — linha 516

**Problema:**
```typescript
if (error) throw new UnauthorizedException(`OAuth error: ${error}`);
```

O `error` query param vem do redirect do IdP e eh refletido na resposta 401. Um atacante que controla a URL (CSRF no callback) pode injetar texto arbitrario na mensagem de erro.

**Como arrumar:**

```typescript
const ALLOWED_OAUTH_ERRORS = ['access_denied', 'server_error', 'temporarily_unavailable', 'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope'];
const safeError = ALLOWED_OAUTH_ERRORS.includes(error) ? error : 'unknown_error';
if (error) throw new UnauthorizedException(`OAuth error: ${safeError}`);
```

**O que pode quebrar:** Nenhum IdP standard envia error codes fora do RFC 6749 section 4.1.2.1. Se um IdP customizado enviar algo diferente, o user ve `unknown_error` — aceitavel e mais seguro que refletir conteudo arbitrario.

---

### H-4 — Redis client instanciado diretamente no controller, sem pool

**Arquivo:** `apps/api/src/modules/auth/auth.controller.ts` — constructor

**Problema:**
`new Redis(requireEnv('REDIS_URL', ...), { maxRetriesPerRequest: 3, lazyConnect: false })` cria uma conexao separada por instancia do controller. Sem `onModuleDestroy` pra fechar. Em hot-reload ou testes, isso vaza conexoes. O resto do codebase usa Redis provider compartilhado.

**Como arrumar:**

Injetar o Redis provider existente no modulo ao inves de instanciar diretamente. Se o modulo de auth ainda nao tem provider de Redis, criar um:

```typescript
// auth.module.ts providers
{
  provide: 'AUTH_REDIS',
  useFactory: () => new Redis(requireEnv('REDIS_URL', ...)),
}

// auth.controller.ts constructor
constructor(@Inject('AUTH_REDIS') private readonly redis: Redis, ...) {}

// Adicionar OnModuleDestroy
async onModuleDestroy() {
  await this.redis.quit();
}
```

Ou melhor: reusar o mesmo provider de Redis que `stream-token.service.ts` ja usa.

**O que pode quebrar:**
- Se o provider compartilhado usa `lazyConnect: true` e o controller precisa de conexao imediata, pode falhar em startup. Testar com `pnpm run test` e verificar se os testes de OAuth callback passam.
- Se o Redis provider existente usa um DB index diferente (ex: `select 1`), as keys `oauth:state:*` vao parar no DB errado. Verificar o `REDIS_URL` usado no provider existente.

---

## Medium

### M-1 — sessionId interpolado na bridge page sem sanitizacao adequada (XSS)

**Arquivo:** `apps/api/src/modules/streaming/streaming.controller.ts` — linhas 641-646

**Problema:**
Na bridge page, `sessionId` eh interpolado direto no template literal do `<script>`:

```javascript
var p='/vnc/${sessionId}'+(t?'?token='+encodeURIComponent(t):'');
```

O `@Param('sessionId')` nao tem `ParseUUIDPipe`. Um atacante pode craftar URL como `/vnc/</script><script>alert(1)//` — o NestJS routing pode aceitar isso dependendo da versao.

Na email gate page (linha 674), a sanitizacao so remove `"`:
```typescript
const safeSessionId = sessionId.replace(/"/g, '');
```
Isso NAO previne `</script>` injection.

**Como arrumar:**

1. Adicionar `ParseUUIDPipe` ao param:
```typescript
@Get(':sessionId')
async openStream(@Param('sessionId', ParseUUIDPipe) sessionId: string, ...)
```

2. Na bridge page, usar `JSON.stringify` (ja usado na email gate pra `SESSION_ID`):
```javascript
var p='/vnc/'+${JSON.stringify(sessionId)}+(t?'?token='+encodeURIComponent(t):'');
```

**O que pode quebrar:**
- Se algum consumer usa sessionId que nao eh UUID (improvavel — o schema usa UUID), vai receber 400. Verificar se `session.id` eh sempre UUID no banco.
- `ParseUUIDPipe` tambem deve ser adicionado ao `@Post(':sessionId/verify-email')` (linha 512) e ao `ShortLinkController` se aplicavel.

---

### M-2 — isRelative suprime `_token` pra todos os paths relativos, nao so VNC

**Arquivo:** `apps/api/src/modules/auth/auth.controller.ts` — linhas 649-656

**Problema:**
```typescript
const isVncRedirect = postLoginRedirectUri.startsWith('/vnc/') || postLoginRedirectUri.startsWith('/s/');
if (isVncRedirect || isRelative) {
  return res.redirect(`${publicBase}${postLoginRedirectUri}`);
}
// Absolute same-origin → appends _token
return res.redirect(`${postLoginRedirectUri}...&_token=...`);
```

Qualquer path relativo (ex: `/admin`) vai pro redirect SEM `_token`. Se o admin-UI algum dia usar `redirect_uri=/admin` ao inves de URL absoluta, a autenticacao quebra silenciosamente.

**Como arrumar:**

Inverter a logica — so suprimir `_token` para VNC paths conhecidos:

```typescript
if (isVncRedirect) {
  return res.redirect(`${publicBase}${postLoginRedirectUri}`);
}
// Tudo que nao eh VNC (relativo ou absoluto same-origin) recebe _token
const separator = postLoginRedirectUri.includes('?') ? '&' : '?';
const dest = isRelative ? `${publicBase}${postLoginRedirectUri}` : postLoginRedirectUri;
return res.redirect(`${dest}${separator}_token=${encodeURIComponent(token)}`);
```

**O que pode quebrar:**
- Se existir algum redirect relativo que NAO deve receber `_token` (alem de `/vnc/` e `/s/`), vai receber agora. Revisar todos os `post_login` values que o admin-UI envia. Atualmente o admin-UI usa URL absoluta, entao nao deve quebrar.

---

### M-3 — Sem Content-Security-Policy na bridge page e email gate page

**Arquivo:** `apps/api/src/modules/streaming/streaming.controller.ts` — linhas 641-650, 676-744

**Problema:**
Ambas as paginas renderizadas tem `<script>` inline sem CSP header. Se qualquer input acabar refletido (sessionId, token), XSS eh possivel. A sanitizacao de `safeToken` (remove `"`) nao previne `</script>` injection.

**Como arrumar:**

Adicionar CSP com nonce:

```typescript
const nonce = crypto.randomBytes(16).toString('base64');
res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`);
// No HTML: <script nonce="${nonce}">
```

**O que pode quebrar:**
- Se a page carrega scripts de CDN (nao carrega atualmente), eles seriam bloqueados pelo CSP. Verificar o `renderViewerPage` tambem — ele carrega noVNC de paths relativos, entao `script-src` precisaria incluir `'self'` alem do nonce pra viewer page.

---

### M-4 — Stream token viaja pelo redirect OAuth e aparece em logs do IdP

**Arquivo:** `apps/api/src/modules/streaming/streaming.controller.ts` — linhas 634-635

**Problema:**
```typescript
const postLogin = `/vnc/${sessionId}?token=${encodeURIComponent(token)}`;
res.redirect(302, `${publicBaseUrl}/auth/oauth/${idp.id}/login?post_login=${encodeURIComponent(postLogin)}`);
```

O stream token viaja: `post_login` param → Redis state → callback redirect → URL final. Aparece em:
- Logs do IdP server (query string do redirect)
- Browser Referer header quando o viewer carrega recursos
- Browser history

Stream tokens tem 600s TTL, o que limita exposicao mas nao elimina.

**Como arrumar:**

Em vez de passar o stream token no `post_login`, armazenar o token no Redis junto com o OAuth state e recuperar no callback:

```typescript
// oauthLogin: armazenar token no state
const statePayload: OAuthStatePayload = { codeVerifier, idpId, postLoginRedirectUri: `/vnc/${sessionId}`, streamToken: token };

// handleOauthCallback: reconstruir redirect com token do Redis
const dest = stored.streamToken ? `${stored.postLoginRedirectUri}?token=${stored.streamToken}` : stored.postLoginRedirectUri;
```

**O que pode quebrar:**
- Precisa atualizar o tipo `OAuthStatePayload` (linha 149) pra incluir `streamToken?: string`.
- Se o OAuth flow demora mais que 600s (TTL do stream token), o token ja expirou quando o callback redireciona. Isso ja acontece no fluxo atual — nao eh regressao.

---

### M-5 — Fallback pro IdP do bootstrap admin expoe cross-tenant auth

**Arquivo:** `apps/api/src/modules/streaming/streaming.controller.ts` — linhas 621-628

**Problema:**
Quando nao existe IdP configurado pro tenant da sessao, o codigo busca o IdP do tenant do admin bootstrap:

```typescript
const adminUser = await this.userRepo.findOne({ where: { email: process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@browser-hitl.local' } });
if (adminUser) {
  idp = await this.idpRepo.findOne({ where: { tenant_id: adminUser.tenant_id, enabled: true, auth_url: Not(IsNull()) } });
}
```

Sessoes do Tenant A sao autenticadas via IdP do Tenant B (admin). O cookie check compara `owner_user_id` mas **nao** compara `tenant_id`. Se o mesmo userId externo existir em ambos os tenants, cross-tenant access eh possivel.

**Como arrumar:**

Se nao existe IdP pro tenant da sessao, cair no email gate ao inves de usar IdP de outro tenant:

```typescript
let idp = await this.idpRepo.findOne({
  where: { tenant_id: session.tenant_id, enabled: true, auth_url: Not(IsNull()) },
});
// SEM fallback pra admin tenant — se nao tem IdP, usa email gate
```

Se o fallback for necessario pra cenario single-tenant (cloud), documentar e adicionar check de `tenant_id` no cookie:

```typescript
// No cookie check (openStream e proxyUpgrade):
if (vncPayload.tenant_id !== session.tenant_id) {
  wrongUser = true;
}
```

**O que pode quebrar:**
- **Deploy cloud single-tenant:** se o tenant da sessao eh diferente do tenant do admin (ex: Frontegg org ID vs admin bootstrap tenant), o OAuth gate nao vai aparecer — cai direto no email gate. Se isso nao eh aceitavel, manter o fallback MAS adicionar a validacao de `tenant_id` no cookie.
- **On-prem multi-tenant:** remover o fallback eh o correto. Cada tenant deve ter seu proprio IdP configurado.

---

## Low

### L-1 — Cookie `tabby_vnc` sem atributo `domain`

**Arquivo:** `auth.controller.ts:622-628`, `streaming.controller.ts:553-559`

**Problema:** Sem `domain`, o cookie fica scoped ao host exato do request. Na topologia de dois hosts (`tabby-api.*` + `tabby-admin.*`), o cookie do API nao eh enviado pro admin-UI. Correto pro VNC (servido pelo API), mas nao documentado.

**Como arrumar:** Documentar a premissa. Se no futuro migrar pra subdomain compartilhado (ex: `*.tabby.example.com`), lembrar de nao omitir `SameSite=None; Secure`.

**O que pode quebrar:** Nada agora. Apenas future-proofing.

---

### L-2 — `verifyEmail` sem rate limit especifico

**Arquivo:** `streaming.controller.ts:509`

**Problema:** O throttle global (60 req/min por IP) permite ~1 tentativa por segundo. O endpoint retorna erros distintos pra "session not found" vs "no owner" vs "email does not match", permitindo enumeracao de sessoes e emails.

**Como arrumar:**

```typescript
@Post(':sessionId/verify-email')
@Throttle({ default: { limit: 5, ttl: 60000 } }) // 5/min por IP
@HttpCode(200)
async verifyEmail(...) {
  // Unificar mensagens de erro:
  // "Session not found" e "Email does not match" → mesma mensagem
}
```

**O que pode quebrar:** Users que erram o email mais de 5 vezes em 1 minuto sao bloqueados. Aceitavel dado o contexto de seguranca.

---

### L-3 — Migration `down()` falha se existem users federados

**Arquivo:** `apps/api/src/migrations/1708300000017-NullablePasswordHash.ts` — linha 9

**Problema:**
```sql
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL
```

Se fezer rollback depois de auto-provisionar users federados (com `password_hash = NULL`), a migration falha com constraint violation.

**Como arrumar:**

```typescript
public async down(queryRunner: QueryRunner): Promise<void> {
  // Set placeholder for federated users before re-adding NOT NULL
  await queryRunner.query(`UPDATE users SET password_hash = 'SSO_USER_NO_PASSWORD' WHERE password_hash IS NULL`);
  await queryRunner.query(`ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL`);
}
```

**O que pode quebrar:** Se alguem tentar fazer login com um user federado depois do rollback, o `bcrypt.compare` vai falhar (hash invalido) — mas o login guard (`password_hash === null → SSO message`) nao vai funcionar. Considerar um valor sentinel que o guard reconheca.

---

### L-4 — `Redis.getdel` requer Redis 6.2+

**Arquivo:** `auth.controller.ts` — linha 521

**Problema:** `getdel` eh Redis 6.2+. Se o deploy usa Redis < 6.2, falha em runtime.

**Como arrumar:**

Usar pipeline GET + DEL se compatibilidade eh necessaria:
```typescript
const raw = await this.redis.get(key);
if (raw) await this.redis.del(key);
```

Ou documentar `Redis >= 6.2` como requisito.

**O que pode quebrar:** O fallback GET + DEL nao eh atomico — em cenario de replay de state (atacante reenvia callback), ambos os requests poderiam ler o state antes do DEL. Janela muito pequena, mas pra eliminar: usar Lua script ou MULTI/EXEC.

---

### L-5 — Auto-provision guard checa `allow_auto_provision` depois de emitir JWT

**Arquivo:** `auth.controller.ts` — linhas 600-618

**Problema:** Se `allow_auto_provision = false`, o user faz login com sucesso (JWT emitido, audit logado) mas nenhuma row local eh criada. O email gate subsequente nao vai funcionar pra esse user.

**Como arrumar:** Documentar que sem `allow_auto_provision`, o email gate eh non-functional pra users federados. Opcionalmente, nao mostrar o email gate quando nao existe user local — so OAuth.

**O que pode quebrar:** Nenhum comportamento atual muda. Apenas documentacao.

---

## Nits

### N-1 — `parseCookie` duplicada

`streaming.controller.ts` (funcao module-level, linha 32) e `vnc-ws-proxy.service.ts` (`parseVncCookie`, linha 250) implementam a mesma logica. Extrair pra shared utility em `packages/shared` ou `src/common/`.

### N-2 — `process.env.PUBLIC_BASE_URL` acessado em ~6 lugares

Mesmo fallback repetido em `auth.controller.ts` e `streaming.controller.ts`. Extrair pra constante module-level ou injetar via `ConfigService`.

### N-3 — Comentario da rota legacy eh misleading

O comentario em `oauthCallback` (linha 494) diz "idpId param is validated against Redis state" mas no generic route o `idpIdHint` eh `undefined` e o check eh pulado. Clarificar.

### N-4 — `wrongUser`/`cookieValid` booleans poderiam ser early return

O two-branch boolean em `openStream` (linhas 592-606) poderia ser um early return, reduzindo complexidade cognitiva no path critico de seguranca.
