import { Types } from 'mongoose';
import { businessDate, expiryState, saleExpiryCheck } from './business-date';
import { compareFefo } from './batch-order';
import {
  productBatchesEnabled,
  productBatchesFlagInvalid,
} from './product-batches-config';
import {
  PRODUCT_BATCH_GUARD_VALIDATOR,
  canonicalJson,
  validatorProblem,
} from './product-batch-guard';
import {
  PERMISSION_CATALOGS,
  mergeUnknownPermissions,
  parsePermissionCatalog,
} from '../../organizations/permissions';
import {
  COMMON_VISIBILITY,
  projectAuditDetails,
  toProductView,
} from '../product-projection';

describe('lots — règle de date du commerce', () => {
  it('jour civil dans le fuseau du commerce, indépendant du fuseau de l’appareil', () => {
    // 23:30 UTC le 16 : déjà le 17 à Douala (UTC+1), encore le 16 à UTC-12.
    const instant = new Date('2026-10-16T23:30:00Z');
    expect(businessDate(instant, 'Africa/Douala')).toBe('2026-10-17');
    expect(businessDate(instant, 'Etc/GMT+12')).toBe('2026-10-16');
    expect(businessDate(instant, 'Pacific/Kiritimati')).toBe('2026-10-17');
  });

  it('dépassé seulement à partir du lendemain ; absence de date distincte', () => {
    expect(expiryState('2026-10-17', '2026-10-17')).toBe('valid');
    expect(expiryState('2026-10-16', '2026-10-17')).toBe('expired');
    expect(expiryState('2026-10-18', '2026-10-17')).toBe('valid');
    expect(expiryState(null, '2026-10-17')).toBe('unknown');
  });
});

describe('lots — drapeau d’activation', () => {
  it('désactivé par défaut ; seule la valeur exacte `true` active', () => {
    expect(productBatchesEnabled({})).toBe(false);
    for (const value of ['', 'false', 'TRUE', '1', 'yes']) {
      expect(productBatchesEnabled({ PRODUCT_BATCHES_ENABLED: value })).toBe(
        false,
      );
    }
    expect(productBatchesEnabled({ PRODUCT_BATCHES_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('valeur inconnue signalée', () => {
    expect(productBatchesFlagInvalid({ PRODUCT_BATCHES_ENABLED: '1' })).toBe(
      true,
    );
    expect(productBatchesFlagInvalid({})).toBe(false);
    expect(
      productBatchesFlagInvalid({ PRODUCT_BATCHES_ENABLED: 'false' }),
    ).toBe(false);
  });
});

describe('lots — garde MongoDB', () => {
  it('validateur exact reconnu, quel que soit l’ordre des clés', () => {
    const reordered = JSON.parse(
      canonicalJson(PRODUCT_BATCH_GUARD_VALIDATOR),
    ) as unknown;
    expect(
      validatorProblem({ name: 'products', options: { validator: reordered } }),
    ).toBeNull();
  });

  it('absent, différent ou non bloquant : refus', () => {
    expect(validatorProblem(undefined)).toBe('validateur des produits absent');
    expect(
      validatorProblem({ name: 'products', options: { validator: { a: 1 } } }),
    ).toBe('validateur des produits différent');
    expect(
      validatorProblem({
        name: 'products',
        options: {
          validator: PRODUCT_BATCH_GUARD_VALIDATOR,
          validationAction: 'warn',
        },
      }),
    ).toBe('action de validation non bloquante');
  });
});

describe('lots — catalogue de permissions', () => {
  it('catalogue 4 = toutes ; 3 sans `stock.manage_batches`', () => {
    expect(PERMISSION_CATALOGS[4]).toContain('stock.manage_batches');
    expect(PERMISSION_CATALOGS[3]).not.toContain('stock.manage_batches');
    expect(PERMISSION_CATALOGS[3]).toContain('products.manage_expiry');
    expect(PERMISSION_CATALOGS[2]).not.toContain('stock.manage_batches');
    expect(PERMISSION_CATALOGS[1]).not.toContain('stock.manage_batches');
    expect(parsePermissionCatalog('4')).toBe(4);
  });

  it('un formulaire au catalogue 3 ne retire jamais la permission des lots', () => {
    expect(
      mergeUnknownPermissions(
        ['products.manage'],
        ['products.manage', 'stock.manage_batches'],
        3,
      ),
    ).toEqual(['products.manage', 'stock.manage_batches']);
    expect(
      mergeUnknownPermissions(
        ['products.manage'],
        ['products.manage', 'stock.manage_batches'],
        4,
      ),
    ).toEqual(['products.manage']);
  });
});

describe('lots — projection', () => {
  const source = {
    _id: 'p',
    sectionId: 's',
    name: 'P',
    purchasePrice: 1,
    salePrice: 2,
    initialQuantity: 10,
    remainingQuantity: 8,
    expiryDate: '2026-12-31',
  };

  it('produit ordinaire : mode `none`, date de la fiche inchangée', () => {
    const view = toProductView(source, COMMON_VISIBILITY, null);
    expect(view.stockTracking).toBe('none');
    expect(view.expiryDate).toBe('2026-12-31');
  });

  it('produit suivi par lots : aucune date unique pour tout le stock', () => {
    const view = toProductView(
      { ...source, stockTracking: 'batches' },
      COMMON_VISIBILITY,
      null,
    );
    expect(view.stockTracking).toBe('batches');
    expect(view.expiryDate).toBeNull();
  });

  it('journal : quantités de lots masquées sans products.view_stock_details', () => {
    const details = {
      reference: 'L-001',
      added: 5,
      allocations: [{ reference: 'L-001', quantity: 5 }],
      totalQuantity: 5,
    };
    expect(projectAuditDetails(details, COMMON_VISIBILITY)).toEqual({
      reference: 'L-001',
    });
    expect(
      projectAuditDetails(details, { stockDetails: true, financials: false }),
    ).toEqual(details);
  });
});

describe('lot B — règle temporelle des ventes par lots', () => {
  const today = '2026-10-18';
  it('lot valide aujourd’hui : accepté quel que soit le jour déclaré', () => {
    expect(saleExpiryCheck('2026-10-18', today, '2026-10-18')).toBe('valid');
    expect(saleExpiryCheck('2026-10-20', today, '2026-10-05')).toBe('valid');
  });
  it('dépassé et vente déclarée après la péremption : refus définitif', () => {
    expect(saleExpiryCheck('2026-10-17', today, '2026-10-18')).toBe('expired');
  });
  it('dépassé mais vente déclarée le dernier jour ou avant : régularisation', () => {
    expect(saleExpiryCheck('2026-10-17', today, '2026-10-17')).toBe(
      'expired_at_sync',
    );
    expect(saleExpiryCheck('2026-10-17', today, '2026-10-10')).toBe(
      'expired_at_sync',
    );
  });
});

describe('lot B — ordre FEFO déterministe', () => {
  const batch = (
    reference: string,
    expiryDate: string | null,
    receivedOn: string | null = null,
    id = new Types.ObjectId(),
  ) => ({ reference, expiryDate, receivedOn, _id: id });
  it('péremption, puis réception (inconnue en dernier), puis référence, puis identifiant', () => {
    const a = batch('L-003', '2026-11-01', '2026-10-01');
    const b = batch('L-001', '2026-11-01', null);
    const c = batch('L-002', '2026-10-25');
    const d = batch('L-004', null, '2026-09-01');
    const e = batch('L-000', '2026-11-01', '2026-10-01');
    const sorted = [d, a, b, c, e].sort(compareFefo).map((x) => x.reference);
    expect(sorted).toEqual(['L-002', 'L-000', 'L-003', 'L-001', 'L-004']);
    const x = batch(
      'L-009',
      '2026-11-01',
      null,
      new Types.ObjectId('a'.repeat(24)),
    );
    const y = batch(
      'L-009',
      '2026-11-01',
      null,
      new Types.ObjectId('b'.repeat(24)),
    );
    expect([y, x].sort(compareFefo)[0]).toBe(x);
  });
});
