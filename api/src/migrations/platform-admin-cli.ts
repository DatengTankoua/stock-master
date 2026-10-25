/**
 * Administration de la plateforme — commande OPÉRATEUR hors interface.
 * Aucune route HTTP, aucune migration automatique ne l'appelle.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api platform-admin -- <commande> [options]
 * Image de production (sans pnpm) :
 *   node /app/api/dist/migrations/platform-admin-cli.js <commande> [options]
 *
 * Commandes :
 *   status     --user-id=<id>
 *   grant      --user-id=<id> --reason=<motif> --operator=<opérateur> [--apply]
 *   revoke     --user-id=<id> --reason=<motif> --operator=<opérateur> [--apply]
 *   reset-mfa  --user-id=<id> --reason=<motif> --operator=<opérateur>
 *              --identity-check=<référence de la vérification d'identité> [--apply]
 *   rotate-key --operator=<opérateur> [--apply]
 *   capability-add    --user-id=<id> --capability=<capacité> --reason=<motif>
 *                     --operator=<opérateur> [--apply]
 *   capability-remove --user-id=<id> --capability=<capacité> --reason=<motif>
 *                     --operator=<opérateur> [--apply]
 *
 * Capacités (`platform-admin-capabilities.ts`) : `platform.read`,
 * `platform.organizations.suspend`, `platform.subscriptions.extend`. Une
 * autorisation accordée (ou réaccordée) commence en lecture seule ; les
 * autres capacités s'ajoutent une par une, sur une autorisation ACTIVE.
 *
 * - LECTURE SEULE par défaut : sans `--apply`, la commande décrit ce qu'elle
 *   ferait et n'écrit rien.
 * - Utilisateur EXISTANT, désigné par son identifiant (24 hex) ; `grant`
 *   exige une adresse vérifiée. Aucun compte créé, aucun mot de passe généré.
 * - Motif obligatoire (10 à 300 caractères) ; chaque écriture est auditée
 *   (`platform_admin_audit`, acteur `operator`) dans la même transaction.
 * - `revoke` et `reset-mfa` révoquent toutes les sessions administratives
 *   de l'utilisateur ; `reset-mfa` supprime le facteur et les codes de
 *   récupération : nouvel enrôlement obligatoire à la prochaine connexion.
 * - `rotate-key` rechiffre les secrets TOTP avec la clé active
 *   (`PLATFORM_ADMIN_MFA_KEYS`, `PLATFORM_ADMIN_MFA_ACTIVE_KEY`).
 * - Ne journalise JAMAIS l'URI, un secret, un code ni une clé.
 */
import { createConnection, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { checkPlatformAdminIndexes } from '../platform-admin/platform-admin-indexes';
import {
  auditDocument,
  platformAdminCollections,
  type AuditEntryInput,
} from '../platform-admin/platform-admin-store';
import { parsePlatformAdminKeyring } from '../platform-admin/platform-admin-config';
import {
  DEFAULT_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  effectiveCapabilities,
  isPlatformCapability,
  type PlatformCapability,
} from '../platform-admin/platform-admin-capabilities';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  type EncryptedTotpSecret,
} from '../platform-admin/totp-secret-cipher';

export const CLI_COMMANDS = [
  'status',
  'grant',
  'revoke',
  'reset-mfa',
  'rotate-key',
  'capability-add',
  'capability-remove',
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface CliArguments {
  command: CliCommand;
  apply: boolean;
  userId?: string;
  reason?: string;
  operator?: string;
  identityCheck?: string;
  capability?: string;
}

const OPTIONS = {
  '--user-id': 'userId',
  '--reason': 'reason',
  '--operator': 'operator',
  '--identity-check': 'identityCheck',
  '--capability': 'capability',
} as const;

const REQUIRED: Record<CliCommand, readonly (keyof typeof OPTIONS)[]> = {
  status: ['--user-id'],
  grant: ['--user-id', '--reason', '--operator'],
  revoke: ['--user-id', '--reason', '--operator'],
  'reset-mfa': ['--user-id', '--reason', '--operator', '--identity-check'],
  'rotate-key': ['--operator'],
  'capability-add': ['--user-id', '--capability', '--reason', '--operator'],
  'capability-remove': ['--user-id', '--capability', '--reason', '--operator'],
};

export const USAGE = [
  'Usage : platform-admin <commande> [options] (lecture seule sans --apply)',
  '  status     --user-id=<id>',
  '  grant      --user-id=<id> --reason=<motif> --operator=<opérateur> [--apply]',
  '  revoke     --user-id=<id> --reason=<motif> --operator=<opérateur> [--apply]',
  '  reset-mfa  --user-id=<id> --reason=<motif> --operator=<opérateur> --identity-check=<référence> [--apply]',
  '  rotate-key --operator=<opérateur> [--apply]',
  '  capability-add    --user-id=<id> --capability=<capacité> --reason=<motif> --operator=<opérateur> [--apply]',
  '  capability-remove --user-id=<id> --capability=<capacité> --reason=<motif> --operator=<opérateur> [--apply]',
  `  capacités : ${PLATFORM_CAPABILITIES.join(', ')}`,
].join('\n');

/** Analyse stricte ; `string` = message d'erreur (jamais une valeur reçue). */
export function parseCliArguments(
  argv: readonly string[],
): CliArguments | string {
  const args = argv.filter((arg) => arg !== '--');
  const command = args[0];
  if (!(CLI_COMMANDS as readonly string[]).includes(command ?? '')) {
    return 'commande inconnue';
  }
  const parsed: CliArguments = { command: command as CliCommand, apply: false };
  const seen = new Set<string>();
  for (const arg of args.slice(1)) {
    if (arg === '--apply') {
      if (parsed.apply) return 'option --apply en double';
      if (command === 'status') return 'status est toujours en lecture seule';
      parsed.apply = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator > 0 ? arg.slice(0, separator) : arg;
    if (!Object.prototype.hasOwnProperty.call(OPTIONS, flag)) {
      return `option inconnue : ${flag.replace(/=.*/, '')}`;
    }
    if (separator < 0) return `${flag} attend une valeur (${flag}=…)`;
    if (seen.has(flag)) return `option ${flag} en double`;
    seen.add(flag);
    parsed[OPTIONS[flag as keyof typeof OPTIONS]] = arg
      .slice(separator + 1)
      .trim();
  }
  const required = REQUIRED[parsed.command];
  for (const flag of required) {
    if (!seen.has(flag)) return `option ${flag} requise`;
  }
  for (const flag of seen) {
    if (!required.includes(flag as keyof typeof OPTIONS)) {
      return `option ${flag} inattendue pour ${parsed.command}`;
    }
  }
  if (
    parsed.capability !== undefined &&
    !isPlatformCapability(parsed.capability)
  ) {
    return `--capability : ${PLATFORM_CAPABILITIES.join(' | ')}`;
  }
  if (parsed.userId !== undefined && !/^[0-9a-f]{24}$/.test(parsed.userId)) {
    return '--user-id : identifiant de 24 caractères hexadécimaux (minuscules)';
  }
  if (
    parsed.reason !== undefined &&
    (parsed.reason.length < 10 || parsed.reason.length > 300)
  ) {
    return '--reason : 10 à 300 caractères';
  }
  if (
    parsed.operator !== undefined &&
    !/^[\p{L}\p{N} ._@-]{2,100}$/u.test(parsed.operator)
  ) {
    return '--operator : 2 à 100 caractères (lettres, chiffres, espace . _ @ -)';
  }
  if (
    parsed.identityCheck !== undefined &&
    (parsed.identityCheck.length < 3 || parsed.identityCheck.length > 200)
  ) {
    return '--identity-check : 3 à 200 caractères';
  }
  return parsed;
}

export interface CliOutcome {
  result: string;
  [key: string]: unknown;
}

type MongoSession = Awaited<ReturnType<Connection['startSession']>>;

async function inTransaction(
  connection: Connection,
  work: (txn: MongoSession) => Promise<void>,
): Promise<void> {
  const txn = await connection.startSession();
  try {
    await txn.withTransaction(() => work(txn));
  } finally {
    await txn.endSession();
  }
}

function operatorAudit(
  args: CliArguments,
  action: AuditEntryInput['action'],
  detail: string,
): AuditEntryInput {
  return {
    actorType: 'operator',
    actorLabel: args.operator ?? null,
    action,
    outcome: 'success',
    targetType: args.userId ? 'user' : null,
    targetId: args.userId ?? null,
    detail,
  };
}

/** Exécution (exportée pour les tests e2e : base éphémère uniquement). */
export async function runPlatformAdminCli(
  connection: Connection,
  args: CliArguments,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<CliOutcome> {
  const problems = await checkPlatformAdminIndexes(connection);
  if (problems.length > 0) {
    throw new Error(
      `index absents (lancer migrate:predeploy) : ${problems.join(', ')}`,
    );
  }
  const db = platformAdminCollections(connection);
  const users = connection.db!.collection('users');

  if (args.command === 'rotate-key') {
    return rotateKey(connection, args, env, now);
  }

  const userId = new Types.ObjectId(args.userId);
  const user = await users.findOne(
    { _id: userId },
    { projection: { emailVerifiedAt: 1 } },
  );
  if (!user) throw new Error('utilisateur introuvable');
  const [grant, factor, activeSessions] = await Promise.all([
    db.grants.findOne({ userId }),
    db.factors.findOne({ userId }),
    db.sessions.countDocuments({
      userId,
      revokedAt: null,
      absoluteExpiresAt: { $gt: now },
    }),
  ]);
  const state = {
    userId: args.userId,
    emailVerified: Boolean(user.emailVerifiedAt),
    access: grant?.status ?? 'none',
    mfa: factor?.active ? 'active' : 'not_enrolled',
    activeSessions,
    capabilities:
      grant?.status === 'active'
        ? [...effectiveCapabilities(grant)].sort()
        : [],
  };

  switch (args.command) {
    case 'status':
      return { result: 'status', ...state };

    case 'grant': {
      if (!user.emailVerifiedAt)
        throw new Error('adresse non vérifiée : accès refusé');
      if (grant?.status === 'active')
        return { result: 'already-active', ...state };
      if (!args.apply) return { result: 'dry-run:grant', ...state };
      await inTransaction(connection, async (txn) => {
        await db.grants.updateOne(
          { userId },
          {
            $set: {
              status: 'active',
              grantedAt: now,
              grantedBy: args.operator!,
              grantReason: args.reason!,
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
              // Toujours lecture seule au départ (moindre privilège).
              capabilities: [...DEFAULT_PLATFORM_CAPABILITIES],
              updatedAt: now,
            },
          },
          { upsert: true, session: txn },
        );
        await db.audit.insertOne(
          {
            _id: new Types.ObjectId(),
            ...auditDocument(
              operatorAudit(args, 'access_grant', args.reason!),
              now,
            ),
          },
          { session: txn },
        );
      });
      return {
        result: 'granted',
        ...state,
        access: 'active',
        capabilities: [...DEFAULT_PLATFORM_CAPABILITIES],
      };
    }

    case 'capability-add':
    case 'capability-remove': {
      if (grant?.status !== 'active') {
        throw new Error('autorisation plateforme non active');
      }
      const capability = args.capability as PlatformCapability;
      const adding = args.command === 'capability-add';
      const current = new Set(effectiveCapabilities(grant));
      if (current.has(capability) === adding) {
        return { result: adding ? 'already-present' : 'not-present', ...state };
      }
      const next = new Set(current);
      if (adding) next.add(capability);
      else next.delete(capability);
      const capabilities = PLATFORM_CAPABILITIES.filter((c) => next.has(c));
      if (!args.apply) {
        return {
          result: `dry-run:${args.command}`,
          ...state,
          capabilitiesAfter: capabilities,
        };
      }
      await inTransaction(connection, async (txn) => {
        // Écriture conditionnée à l'état lu (aucun écrasement silencieux
        // d'une modification concurrente).
        const updated = await db.grants.updateOne(
          {
            userId,
            status: 'active',
            updatedAt: grant.updatedAt,
          },
          { $set: { capabilities, updatedAt: now } },
          { session: txn },
        );
        if (updated.matchedCount === 0) {
          throw new Error('autorisation modifiée entre-temps : relancer');
        }
        await db.audit.insertOne(
          {
            _id: new Types.ObjectId(),
            ...auditDocument(
              {
                ...operatorAudit(
                  args,
                  adding ? 'capability_grant' : 'capability_revoke',
                  args.reason!,
                ),
                capability,
                before: { capabilities: [...current].sort().join(',') },
                after: { capabilities: capabilities.join(',') },
              },
              now,
            ),
          },
          { session: txn },
        );
      });
      return {
        result: adding ? 'capability-added' : 'capability-removed',
        ...state,
        capabilities,
      };
    }

    case 'revoke': {
      if (grant?.status !== 'active') return { result: 'not-active', ...state };
      if (!args.apply) return { result: 'dry-run:revoke', ...state };
      await inTransaction(connection, async (txn) => {
        await db.grants.updateOne(
          { userId, status: 'active' },
          {
            $set: {
              status: 'revoked',
              revokedAt: now,
              revokedBy: args.operator!,
              revokeReason: args.reason!,
              updatedAt: now,
            },
          },
          { session: txn },
        );
        await db.sessions.updateMany(
          { userId, revokedAt: null },
          { $set: { revokedAt: now, revokeReason: 'access_revoked' } },
          { session: txn },
        );
        await db.audit.insertOne(
          {
            _id: new Types.ObjectId(),
            ...auditDocument(
              operatorAudit(args, 'access_revoke', args.reason!),
              now,
            ),
          },
          { session: txn },
        );
      });
      return {
        result: 'revoked',
        ...state,
        access: 'revoked',
        activeSessions: 0,
      };
    }

    case 'reset-mfa': {
      if (!factor && activeSessions === 0) {
        return { result: 'nothing-to-reset', ...state };
      }
      if (!args.apply) return { result: 'dry-run:reset-mfa', ...state };
      await inTransaction(connection, async (txn) => {
        await db.sessions.updateMany(
          { userId, revokedAt: null },
          { $set: { revokedAt: now, revokeReason: 'mfa_reset' } },
          { session: txn },
        );
        await db.factors.deleteOne({ userId }, { session: txn });
        await db.recoveryCodes.deleteMany({ userId }, { session: txn });
        await db.audit.insertOne(
          {
            _id: new Types.ObjectId(),
            ...auditDocument(
              operatorAudit(
                args,
                'mfa_reset',
                `${args.reason!} | identité : ${args.identityCheck!}`,
              ),
              now,
            ),
          },
          { session: txn },
        );
      });
      return {
        result: 'mfa-reset',
        ...state,
        mfa: 'not_enrolled',
        activeSessions: 0,
      };
    }
  }
  throw new Error('commande inconnue');
}

async function rotateKey(
  connection: Connection,
  args: CliArguments,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<CliOutcome> {
  const { keyring, problems } = parsePlatformAdminKeyring(env);
  if (!keyring) throw new Error(`clés invalides : ${problems.join(' ; ')}`);
  const db = platformAdminCollections(connection);
  const stale = await db.factors
    .find({
      $or: [
        { 'active.keyId': { $nin: [keyring.activeKeyId, null] } },
        { 'pending.keyId': { $nin: [keyring.activeKeyId, null] } },
      ],
    })
    .toArray();
  if (!args.apply) {
    return {
      result: 'dry-run:rotate-key',
      activeKeyId: keyring.activeKeyId,
      factorsToRotate: stale.length,
    };
  }
  let rotated = 0;
  const reencrypt = (secret: EncryptedTotpSecret | null, userId: string) =>
    secret && secret.keyId !== keyring.activeKeyId
      ? encryptTotpSecret(
          decryptTotpSecret(secret, userId, keyring),
          userId,
          keyring,
        )
      : secret;
  for (const factor of stale) {
    const userId = factor.userId.toHexString();
    // Mise à jour conditionnelle : un facteur modifié entre-temps est
    // laissé tel quel (relancer la commande).
    const updated = await db.factors.updateOne(
      { _id: factor._id, active: factor.active, pending: factor.pending },
      {
        $set: {
          active: reencrypt(factor.active, userId),
          pending: reencrypt(factor.pending, userId),
          updatedAt: now,
        },
      },
    );
    rotated += updated.modifiedCount;
  }
  await db.audit.insertOne({
    _id: new Types.ObjectId(),
    ...auditDocument(
      {
        ...operatorAudit(
          args,
          'key_rotation',
          `clé active ${keyring.activeKeyId}`,
        ),
        detail: `clé active ${keyring.activeKeyId} ; ${rotated}/${stale.length} facteur(s)`,
      },
      now,
    ),
  });
  return {
    result: 'rotated',
    activeKeyId: keyring.activeKeyId,
    factorsRotated: rotated,
    factorsSkipped: stale.length - rotated,
  };
}

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`${args}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    console.log(JSON.stringify(await runPlatformAdminCli(connection, args)));
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'platform-admin échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
