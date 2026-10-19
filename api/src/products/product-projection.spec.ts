import { Types } from 'mongoose';
import {
  COMMON_VISIBILITY,
  computeStatus,
  toProductMetricsView,
  toProductView,
} from './product-projection';

const SOURCE = {
  _id: new Types.ObjectId('223344556677889900112233'),
  sectionId: new Types.ObjectId('112233445566778899001122'),
  name: 'Prod',
  // Champs de stockage : jamais projetés tels quels (l'URL est fournie).
  imageUrl: 'http://ancien/p.png',
  imageKey: 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/products/k.jpg',
  imageStorage: 'r2/stockmaster-prod',
  purchasePrice: 1000,
  salePrice: 1500,
  initialQuantity: 10,
  remainingQuantity: 5,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  // Champs internes jamais projetés :
  organizationId: new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
  __v: 0,
};

const SIGNED = 'https://signed.example/k.jpg?X-Amz-Expires=900';

const STANDARD_PRODUCT_KEYS = [
  '_id',
  'createdAt',
  'deletedAt',
  'expiryDate',
  'imageUrl',
  'lowStockThreshold',
  'name',
  'remainingQuantity',
  'salePrice',
  'sectionId',
  'stockTracking',
  'updatedAt',
];

/** Projection exacte (1-12H) : allowlist par groupe, rien d'autre. */
describe('projection produit (1-12H)', () => {
  it.each([
    [
      'standard',
      COMMON_VISIBILITY,
      STANDARD_PRODUCT_KEYS,
      ['product', 'status'],
    ],
    [
      'détail du stock',
      { stockDetails: true, financials: false },
      [...STANDARD_PRODUCT_KEYS, 'initialQuantity'],
      ['product', 'status', 'unitsSold'],
    ],
    [
      'finances',
      { stockDetails: false, financials: true },
      [...STANDARD_PRODUCT_KEYS, 'purchasePrice'],
      [
        'actualProfit',
        'actualRevenue',
        'margin',
        'product',
        'status',
        'totalPurchaseCost',
      ],
    ],
    [
      'deux groupes',
      { stockDetails: true, financials: true },
      [...STANDARD_PRODUCT_KEYS, 'initialQuantity', 'purchasePrice'],
      [
        'actualProfit',
        'actualRevenue',
        'margin',
        'product',
        'status',
        'totalPurchaseCost',
        'unitsSold',
      ],
    ],
  ])('%s : clés exactes', (_label, visibility, productKeys, metricKeys) => {
    const view = toProductMetricsView(SOURCE, visibility, SIGNED, 9000);
    expect(Object.keys(view).sort()).toEqual([...metricKeys].sort());
    expect(Object.keys(view.product).sort()).toEqual([...productKeys].sort());
    expect(
      Object.keys(toProductView(SOURCE, visibility, SIGNED)).sort(),
    ).toEqual([...productKeys].sort());
  });

  it('URL de photo : celle fournie par le service, jamais la clé, le stockage ni l’ancienne URL du document', () => {
    const view = toProductView(SOURCE, COMMON_VISIBILITY, SIGNED);
    expect(view.imageUrl).toBe(SIGNED);
    expect(JSON.stringify(view)).not.toContain('imageKey');
    expect(JSON.stringify(view)).not.toContain('r2/stockmaster-prod');
    expect(toProductView(SOURCE, COMMON_VISIBILITY, null).imageUrl).toBeNull();
  });

  it('formules conservées : CA réel fourni, bénéfice = CA − achat × vendus, marge = bénéfice / CA, coût = achat × initial', () => {
    const view = toProductMetricsView(
      SOURCE,
      { stockDetails: true, financials: true },
      SIGNED,
      9000,
    );
    expect(view.unitsSold).toBe(5);
    expect(view.actualRevenue).toBe(9000);
    expect(view.actualProfit).toBe(9000 - 1000 * 5);
    expect(view.margin).toBeCloseTo((4000 / 9000) * 100);
    expect(view.totalPurchaseCost).toBe(10000);
  });

  it('CA nul : marge null (non calculable), jamais une valeur inventée', () => {
    const view = toProductMetricsView(
      SOURCE,
      { stockDetails: false, financials: true },
      SIGNED,
      0,
    );
    expect(view.margin).toBeNull();
  });

  it('produit existant sans date ni seuil : `null` exposés, statut par défaut inchangé', () => {
    const view = toProductMetricsView(SOURCE, COMMON_VISIBILITY, SIGNED);
    expect(view.product.expiryDate).toBeNull();
    expect(view.product.lowStockThreshold).toBeNull();
    expect(view.status).toBe('in_stock'); // 5 / 10 restants
  });

  it('date civile et seuil `0` exposés tels quels (standard), jamais convertis', () => {
    const view = toProductView(
      { ...SOURCE, expiryDate: '2026-02-28', lowStockThreshold: 0 },
      COMMON_VISIBILITY,
      SIGNED,
    );
    expect(view.expiryDate).toBe('2026-02-28');
    expect(view.lowStockThreshold).toBe(0);
  });
});

describe('statut de stock (règle centrale)', () => {
  const status = (
    initialQuantity: number,
    remainingQuantity: number,
    lowStockThreshold?: number | null,
  ) =>
    computeStatus({
      ...SOURCE,
      initialQuantity,
      remainingQuantity,
      lowStockThreshold,
    });

  it('règle par défaut inchangée : restant ≤ 20 % de la quantité initiale', () => {
    expect(status(100, 21)).toBe('in_stock');
    expect(status(100, 20)).toBe('low_stock');
    expect(status(7, 2)).toBe('in_stock');
    expect(status(7, 1)).toBe('low_stock');
    expect(status(100, 0)).toBe('out_of_stock');
    expect(status(100, 20, null)).toBe('low_stock');
  });

  it('seuil personnalisé : faible strictement en dessous, jamais au seuil', () => {
    expect(status(100, 11, 10)).toBe('in_stock');
    expect(status(100, 10, 10)).toBe('in_stock');
    expect(status(100, 9, 10)).toBe('low_stock');
    // Remplace la règle par défaut dans les deux sens.
    expect(status(100, 20, 5)).toBe('in_stock');
    expect(status(100, 50, 60)).toBe('low_stock');
  });

  it('seuil 0 : jamais faible, seule la rupture est signalée', () => {
    expect(status(100, 1, 0)).toBe('in_stock');
    expect(status(100, 0, 0)).toBe('out_of_stock');
  });
});
