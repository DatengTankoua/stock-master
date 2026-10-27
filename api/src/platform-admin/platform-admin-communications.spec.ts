import { EmailDeliveryError } from '../email-verification/email-sender';
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_MAX_RECIPIENTS,
  MESSAGE_TITLE_MAX_LENGTH,
  actionContentHash,
  auditCapability,
  intentCapabilities,
  normalizeIntent,
  normalizeOrganizationAction,
} from './platform-admin-action-intent';
import {
  DEFAULT_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES,
} from './platform-admin-capabilities';
import { DELEGABLE_PERMISSIONS } from '../organizations/permissions';
import { buildPlatformMessageEmail } from './platform-message-email';
import {
  MESSAGE_MANUAL_RETRY_MAX,
  MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
  classifyEmailFailure,
} from './platform-message-policy';
import { retryState } from './platform-admin-communications.service';
import { parseCliArguments } from '../migrations/platform-admin-cli';

const ORG = 'a'.repeat(24);
const U1 = '1'.repeat(24);
const U2 = '2'.repeat(24);
const OP = '3b241101-e2bb-4255-8caf-4136c566a962';

const message = (overrides: Record<string, unknown> = {}) => ({
  action: 'organization_message',
  organizationId: ORG,
  operationId: OP,
  channels: ['in_app'],
  recipientUserIds: [U1],
  title: 'Maintenance prévue',
  body: 'Bonjour,\nune maintenance aura lieu ce soir.',
  ...overrides,
});

describe('Capacités de communication', () => {
  it('deux capacités distinctes, jamais par défaut ni délégables', () => {
    expect(PLATFORM_CAPABILITIES).toEqual(
      expect.arrayContaining([
        'platform.communications.notify',
        'platform.communications.email',
      ]),
    );
    expect(DEFAULT_PLATFORM_CAPABILITIES).toEqual(['platform.read']);
    for (const permission of DELEGABLE_PERMISSIONS as readonly string[]) {
      expect(permission.startsWith('platform.')).toBe(false);
    }
  });

  it('la commande opérateur les accepte', () => {
    for (const capability of [
      'platform.communications.notify',
      'platform.communications.email',
    ]) {
      expect(
        parseCliArguments([
          'capability-add',
          `--user-id=${U1}`,
          `--capability=${capability}`,
          '--reason=Recette des communications',
          '--operator=test',
        ]),
      ).toMatchObject({ command: 'capability-add', capability });
    }
  });

  it('un canal = une capacité ; « les deux » exige les deux', () => {
    const inApp = normalizeIntent(message());
    const email = normalizeIntent(message({ channels: ['email'] }));
    const both = normalizeIntent(message({ channels: ['email', 'in_app'] }));
    expect(intentCapabilities(inApp)).toEqual([
      'platform.communications.notify',
    ]);
    expect(intentCapabilities(email)).toEqual([
      'platform.communications.email',
    ]);
    expect(intentCapabilities(both)).toEqual([
      'platform.communications.notify',
      'platform.communications.email',
    ]);
    expect(auditCapability(both)).toBeNull();
    const retry = normalizeIntent({
      action: 'organization_message_retry',
      organizationId: ORG,
      operationId: OP,
      messageId: U2,
      channel: 'email',
      deliveryIds: [U1],
    });
    expect(intentCapabilities(retry)).toEqual([
      'platform.communications.email',
    ]);
  });

  it('les routes des actions refusent une intention de message', () => {
    expect(() => normalizeOrganizationAction(message())).toThrow();
  });
});

describe('Intention de message : forme canonique et empreinte', () => {
  it('destinataires dédupliqués et triés, canaux dans un ordre fixe', () => {
    const a = normalizeIntent(
      message({
        recipientUserIds: [U2, U1, U2],
        channels: ['email', 'in_app'],
      }),
    );
    const b = normalizeIntent(
      message({ recipientUserIds: [U1, U2], channels: ['in_app', 'email'] }),
    );
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      recipientUserIds: [U1, U2],
      channels: ['in_app', 'email'],
    });
    expect(actionContentHash(a)).toBe(actionContentHash(b));
  });

  it('toute modification change l’empreinte', () => {
    const base = actionContentHash(normalizeIntent(message()));
    for (const change of [
      { title: 'Autre titre' },
      { body: 'Autre texte' },
      { channels: ['email'] },
      { recipientUserIds: [U1, U2] },
      { operationId: '9b241101-e2bb-4255-8caf-4136c566a962' },
      { organizationId: 'b'.repeat(24) },
    ]) {
      expect(actionContentHash(normalizeIntent(message(change)))).not.toBe(
        base,
      );
    }
  });

  it('texte brut : fins de ligne unifiées, bords retirés, contrôles refusés', () => {
    expect(
      normalizeIntent(message({ body: '  a\r\nb\rc  ' })) as { body: string },
    ).toMatchObject({ body: 'a\nb\nc' });
    expect(() => normalizeIntent(message({ title: 'a\nb' }))).toThrow();
    expect(() => normalizeIntent(message({ body: 'a\u0000b' }))).toThrow();
    expect(() => normalizeIntent(message({ title: '   ' }))).toThrow();
    expect(() => normalizeIntent(message({ body: '' }))).toThrow();
  });

  it('bornes : titre 150, texte 5 000 (au-delà : refus)', () => {
    expect(() =>
      normalizeIntent(message({ title: 'x'.repeat(MESSAGE_TITLE_MAX_LENGTH) })),
    ).not.toThrow();
    expect(() =>
      normalizeIntent(
        message({ title: 'x'.repeat(MESSAGE_TITLE_MAX_LENGTH + 1) }),
      ),
    ).toThrow();
    expect(() =>
      normalizeIntent(message({ body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH) })),
    ).not.toThrow();
    expect(() =>
      normalizeIntent(
        message({ body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1) }),
      ),
    ).toThrow();
  });

  it('trop de destinataires : refus explicite, jamais de troncature', () => {
    const many = Array.from({ length: MESSAGE_MAX_RECIPIENTS + 1 }, (_, i) =>
      i.toString(16).padStart(24, '0'),
    );
    let thrown: unknown;
    try {
      normalizeIntent(message({ recipientUserIds: many }));
    } catch (error) {
      thrown = error;
    }
    expect(
      (thrown as { getResponse(): { code: string } }).getResponse().code,
    ).toBe('PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT');
    expect(() =>
      normalizeIntent(
        message({ recipientUserIds: many.slice(0, MESSAGE_MAX_RECIPIENTS) }),
      ),
    ).not.toThrow();
  });

  it('identifiants et canaux invalides refusés', () => {
    for (const change of [
      { recipientUserIds: [] },
      { recipientUserIds: ['not-an-id'] },
      { recipientUserIds: [{ $ne: null }] },
      { channels: [] },
      { channels: ['sms'] },
      { channels: 'email' },
    ]) {
      expect(() => normalizeIntent(message(change))).toThrow();
    }
  });
});

describe('E-mail d’un message de service', () => {
  const input = {
    title: 'Alerte <b>importante</b> & "test"',
    body: '<script>alert(1)</script>\nLigne 2 <a href="https://evil.example">clic</a>',
    organizationName: 'Boutique <i>Test</i>',
    supportAddress: 'support@stock-master.app',
    locale: 'fr' as const,
  };

  it('HTML entièrement échappé ; texte brut conservé tel quel', () => {
    const email = buildPlatformMessageEmail(input);
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<a href');
    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('&amp; &quot;test&quot;');
    expect(email.text).toContain(input.body);
    expect(email.subject).toBe(
      'Alerte <b>importante</b> & "test" – Stock Master',
    );
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it('habillage dans la langue du destinataire, contenu non traduit', () => {
    const fr = buildPlatformMessageEmail(input);
    const en = buildPlatformMessageEmail({ ...input, locale: 'en' });
    expect(fr.text).toContain('Message de Stock Master');
    expect(en.text).toContain('Message from Stock Master');
    expect(en.text).toContain(input.body);
    expect(en.html).toContain('lang="en"');
  });

  it('déterministe (condition de l’idempotence du prestataire)', () => {
    expect(buildPlatformMessageEmail(input)).toEqual(
      buildPlatformMessageEmail(input),
    );
  });
});

describe('Issue d’un envoi d’e-mail', () => {
  it.each([
    [new EmailDeliveryError('not_configured'), 'failed'],
    [new EmailDeliveryError('rejected', 422), 'failed'],
    [new EmailDeliveryError('rejected', 429), 'retry'],
    [new EmailDeliveryError('timeout'), 'unknown'],
    [new EmailDeliveryError('network'), 'unknown'],
    [new EmailDeliveryError('rejected', 503), 'unknown'],
    [new EmailDeliveryError('rejected', 409), 'unknown'],
    [new Error('inattendue'), 'unknown'],
  ])('%s → %s', (error, outcome) => {
    expect(classifyEmailFailure(error).outcome).toBe(outcome);
  });
});

describe('Relance manuelle', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const base = {
    status: 'failed' as const,
    manualRetries: 0,
    uncertainAt: null,
    firstAttemptAt: new Date(now.getTime() - 60_000),
  };

  it('échec ou incertitude seulement ; jamais une livraison réussie', () => {
    expect(retryState(base, now)).toBe('retryable');
    for (const status of [
      'accepted',
      'created',
      'skipped',
      'pending',
      'sending',
    ] as const) {
      expect(retryState({ ...base, status }, now)).toBe('not_retryable');
    }
  });

  it('relances bornées', () => {
    expect(
      retryState({ ...base, manualRetries: MESSAGE_MANUAL_RETRY_MAX }, now),
    ).toBe('not_retryable');
  });

  it('après une incertitude : seulement dans la fenêtre du prestataire', () => {
    const uncertain = {
      ...base,
      status: 'uncertain' as const,
      uncertainAt: base.firstAttemptAt,
    };
    expect(retryState(uncertain, now)).toBe('retryable');
    expect(
      retryState(
        {
          ...uncertain,
          firstAttemptAt: new Date(
            now.getTime() - MESSAGE_UNCERTAIN_RETRY_WINDOW_MS - 1,
          ),
        },
        now,
      ),
    ).toBe('window_expired');
  });
});
