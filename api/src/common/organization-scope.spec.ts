import {
  inOrganizationScope,
  organizationScopeIds,
  parseOrganizationScope,
} from './organization-scope';
import { productBatchesEnabledFor } from '../products/batches/product-batches-config';
import { expiryAlertsEnabledFor } from '../products/expiry/expiry-alerts-config';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

describe('activation par commerce (pilote)', () => {
  it('explicite : all = tous ; liste = commerces listés ; absente, vide ou invalide = aucun', () => {
    expect(parseOrganizationScope(undefined)).toEqual({ kind: 'none' });
    expect(parseOrganizationScope('  ')).toEqual({ kind: 'none' });
    expect(organizationScopeIds({ kind: 'none' })).toEqual([]);
    expect(inOrganizationScope({ kind: 'none' }, A)).toBe(false);
    expect(parseOrganizationScope(' ALL ')).toEqual({ kind: 'all' });
    expect(inOrganizationScope(parseOrganizationScope('all'), A)).toBe(true);
    expect(parseOrganizationScope(`all,${A}`)).toEqual({ kind: 'invalid' });
    const list = parseOrganizationScope(` ${A.toUpperCase()} ,${B}`);
    expect(inOrganizationScope(list, A)).toBe(true);
    expect(inOrganizationScope(list, 'c'.repeat(24))).toBe(false);
    const invalid = parseOrganizationScope(`${A},pas-un-id`);
    expect(invalid).toEqual({ kind: 'invalid' });
    expect(inOrganizationScope(invalid, A)).toBe(false);
    expect(organizationScopeIds(invalid)).toEqual([]);
    expect(organizationScopeIds({ kind: 'all' })).toBeNull();
  });

  it('drapeau requis ET commerce dans la portée, pour chaque fonctionnalité', () => {
    const env = {
      PRODUCT_BATCHES_ENABLED: 'true',
      PRODUCT_BATCHES_ORGANIZATIONS: A,
      EXPIRY_ALERTS_ENABLED: 'true',
      EXPIRY_ALERTS_ORGANIZATIONS: B,
    };
    expect(productBatchesEnabledFor(A, env)).toBe(true);
    expect(productBatchesEnabledFor(B, env)).toBe(false);
    expect(expiryAlertsEnabledFor(B, env)).toBe(true);
    expect(expiryAlertsEnabledFor(A, env)).toBe(false);
    expect(
      productBatchesEnabledFor(A, { PRODUCT_BATCHES_ORGANIZATIONS: A }),
    ).toBe(false);
    // Drapeau activé sans liste : aucun commerce (jamais global implicite).
    expect(
      productBatchesEnabledFor(B, { PRODUCT_BATCHES_ENABLED: 'true' }),
    ).toBe(false);
    expect(
      expiryAlertsEnabledFor(B, {
        EXPIRY_ALERTS_ENABLED: 'true',
        EXPIRY_ALERTS_ORGANIZATIONS: 'all',
      }),
    ).toBe(true);
  });
});
