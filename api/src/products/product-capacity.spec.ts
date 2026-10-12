import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRODUCT_CAPACITY,
  PRODUCT_CAPACITY_REACHED,
  productCapacityReached,
} from './product-capacity';
// Source unique (test seulement) : le web réexporte la constante serveur.
import { PRODUCT_CAPACITY as WEB_PRODUCT_CAPACITY } from '../../../web/src/lib/product-capacity';

const WEB = join(__dirname, '../../../web/src');
const read = (relative: string) => readFileSync(join(WEB, relative), 'utf8');

describe('Capacité incluse — source unique (1-21D)', () => {
  it('1 000 fiches ; refus au plafond et au-delà seulement', () => {
    expect(PRODUCT_CAPACITY).toBe(1000);
    expect(PRODUCT_CAPACITY_REACHED).toBe('PRODUCT_CAPACITY_REACHED');
    expect(productCapacityReached(999)).toBe(false);
    expect(productCapacityReached(1000)).toBe(true);
    expect(productCapacityReached(1005)).toBe(true);
  });

  it('le web réexporte la constante serveur, sans copie du nombre', () => {
    expect(WEB_PRODUCT_CAPACITY).toBe(PRODUCT_CAPACITY);
    const sources = [
      'lib/product-capacity.ts',
      'components/products/product-capacity.tsx',
      'i18n/resources/fr/catalog.ts',
      'i18n/resources/en/catalog.ts',
      'i18n/documents/conditions-abonnement/fr.tsx',
      'i18n/documents/conditions-abonnement/en.tsx',
    ];
    for (const file of sources) {
      expect(read(file)).not.toMatch(/\b1[  ,.]?000\b/);
    }
    expect(read('lib/product-capacity.ts')).toContain(
      'from "../../../api/src/products/product-capacity"',
    );
  });
});
