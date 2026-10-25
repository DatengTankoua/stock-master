import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PLATFORM_ADMIN_AUDIT_ACTIONS } from '../platform-admin-store';
import { SubscriptionPaymentStatus } from '../../subscriptions/payments/schemas/subscription-payment.schema';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOTP = /^\d{6}$/;
const RECOVERY = /^[A-Za-z2-7\s-]{16,24}$/;

export class AdminLoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;

  /** Défi anti-robot, seulement après trop d'échecs sur le compte. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  challengeToken?: string;
}

export class AdminCodeDto {
  @Matches(TOKEN)
  challengeToken: string;

  @Matches(TOTP)
  code: string;
}

export class AdminVerifyDto {
  @Matches(TOKEN)
  challengeToken: string;

  @IsOptional()
  @Matches(TOTP)
  code?: string;

  @IsOptional()
  @Matches(RECOVERY)
  recoveryCode?: string;
}

export class AdminStepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @Matches(TOTP)
  code?: string;

  @IsOptional()
  @Matches(RECOVERY)
  recoveryCode?: string;

  /**
   * Action à confirmer (preuve liée) : validée et mise en forme canonique
   * par `normalizeIntent` (400 si incomplète ou hors bornes).
   */
  @IsOptional()
  @IsObject()
  intent?: Record<string, unknown>;
}

const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Champs communs : identifiant d'opération et preuve renforcée liée. */
class AdminActionDto {
  @Matches(OPERATION_ID)
  operationId: string;

  @Matches(TOKEN)
  stepUpToken: string;
}

export class AdminSuspendDto extends AdminActionDto {
  /** Motif INTERNE à la plateforme (jamais montré au commerce). */
  @IsString()
  @MaxLength(600)
  internalReason: string;

  /** Message affiché au propriétaire du commerce. */
  @IsString()
  @MaxLength(600)
  clientMessage: string;
}

export class AdminReactivateDto extends AdminActionDto {
  @IsString()
  @MaxLength(600)
  reason: string;
}

export class AdminExtendDto extends AdminActionDto {
  @IsInt()
  days: number;

  @IsString()
  @MaxLength(600)
  reason: string;

  /** Fin de couverture présentée dans l'aperçu confirmé (`null` : aucune). */
  @ValidateIf((dto: AdminExtendDto) => dto.expectedCoverageEndsAt !== null)
  @IsString()
  @MaxLength(40)
  expectedCoverageEndsAt: string | null;
}

export class AdminExtensionPreviewQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days: number;
}

export class AdminStepUpTokenDto {
  @Matches(TOKEN)
  stepUpToken: string;
}

export const ADMIN_PAGE_MAX = 500;

export class AdminPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_PAGE_MAX)
  page?: number;
}

export const ORGANIZATION_SUBSCRIPTION_FILTERS = [
  'trial',
  'paid',
  'offered',
  'manual',
  'scheduled',
  'expired',
  'none',
] as const;
export type OrganizationSubscriptionFilter =
  (typeof ORGANIZATION_SUBSCRIPTION_FILTERS)[number];

export class AdminOrganizationsQuery extends AdminPageQuery {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';

  @IsOptional()
  @IsIn(ORGANIZATION_SUBSCRIPTION_FILTERS)
  subscription?: OrganizationSubscriptionFilter;
}

export class AdminPaymentsQuery extends AdminPageQuery {
  @IsOptional()
  @IsIn(Object.values(SubscriptionPaymentStatus))
  status?: SubscriptionPaymentStatus;

  @IsOptional()
  @Matches(/^[0-9a-f]{24}$/)
  organizationId?: string;
}

export class AdminAuditQuery extends AdminPageQuery {
  @IsOptional()
  @IsIn(PLATFORM_ADMIN_AUDIT_ACTIONS)
  action?: (typeof PLATFORM_ADMIN_AUDIT_ACTIONS)[number];

  @IsOptional()
  @IsIn(['success', 'failure', 'denied'])
  outcome?: 'success' | 'failure' | 'denied';
}
