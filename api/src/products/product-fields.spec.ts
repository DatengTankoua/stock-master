import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { isCivilDate } from './product-fields';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

const BASE_CREATE = {
  sectionId: '112233445566778899001122',
  name: 'Lait corporel',
  purchasePrice: '1000',
  salePrice: '1500',
  initialQuantity: '10',
};

function create(extra: Record<string, unknown>) {
  const dto = plainToInstance(CreateProductDto, { ...BASE_CREATE, ...extra });
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

function update(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateProductDto, body);
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

describe('date de péremption — date civile AAAA-MM-JJ', () => {
  it('dates valides, 29 février bissextile', () => {
    expect(isCivilDate('2026-10-17')).toBe(true);
    expect(isCivilDate('2028-02-29')).toBe(true);
    expect(isCivilDate('2000-01-01')).toBe(true);
  });

  it('refus : jour inexistant, format, heure ou fuseau, hors bornes', () => {
    for (const value of [
      '2026-02-29',
      '2026-13-01',
      '2026-04-31',
      '2026-1-5',
      '17/10/2026',
      '2026-10-17T00:00:00Z',
      '2026-10-17T23:00:00+01:00',
      '1999-12-31',
      '2101-01-01',
      '',
      20261017,
      null,
    ]) {
      expect(isCivilDate(value)).toBe(false);
    }
  });

  it('stable entre fuseaux : aucune conversion, la chaîne est conservée telle quelle', () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'Africa/Douala', 'Etc/GMT+12']) {
        process.env.TZ = tz;
        const { dto, errors } = update({ expiryDate: '2026-01-01' });
        expect(errors).toEqual([]);
        expect(dto.expiryDate).toBe('2026-01-01');
      }
    } finally {
      process.env.TZ = previous;
    }
  });
});

describe('CreateProductDto — champs facultatifs', () => {
  it('absents : produit créé comme avant', () => {
    const { dto, errors } = create({});
    expect(errors).toEqual([]);
    expect(dto.expiryDate).toBeUndefined();
    expect(dto.lowStockThreshold).toBeUndefined();
  });

  it('multipart : chaîne vide = non renseigné (jamais 0)', () => {
    const { dto, errors } = create({ expiryDate: '', lowStockThreshold: '' });
    expect(errors).toEqual([]);
    expect(dto.expiryDate).toBeUndefined();
    expect(dto.lowStockThreshold).toBeUndefined();
  });

  it('date passée acceptée ; seuil 0 explicite conservé', () => {
    const { dto, errors } = create({
      expiryDate: '2020-05-01',
      lowStockThreshold: '0',
    });
    expect(errors).toEqual([]);
    expect(dto.expiryDate).toBe('2020-05-01');
    expect(dto.lowStockThreshold).toBe(0);
  });

  it('refus : seuil négatif, non numérique ; date invalide', () => {
    for (const extra of [
      { lowStockThreshold: '-1' },
      { lowStockThreshold: 'abc' },
      { lowStockThreshold: 'Infinity' },
      { expiryDate: '2026-02-30' },
      { expiryDate: 'demain' },
    ]) {
      expect(create(extra).errors.length).toBeGreaterThan(0);
    }
  });
});

describe('UpdateProductDto — renseigner, modifier, effacer', () => {
  it('absents : inchangés (undefined)', () => {
    const { dto, errors } = update({ name: 'X' });
    expect(errors).toEqual([]);
    expect(dto.expiryDate).toBeUndefined();
    expect(dto.lowStockThreshold).toBeUndefined();
  });

  it('JSON `null` et multipart vide : effacement (null)', () => {
    for (const body of [
      { expiryDate: null, lowStockThreshold: null },
      { expiryDate: '', lowStockThreshold: '' },
    ]) {
      const { dto, errors } = update(body);
      expect(errors).toEqual([]);
      expect(dto.expiryDate).toBeNull();
      expect(dto.lowStockThreshold).toBeNull();
    }
  });

  it('valeurs : nombre JSON, texte multipart, 0 distinct de vide', () => {
    expect(update({ lowStockThreshold: 7 }).dto.lowStockThreshold).toBe(7);
    expect(update({ lowStockThreshold: '7' }).dto.lowStockThreshold).toBe(7);
    expect(update({ lowStockThreshold: 0 }).dto.lowStockThreshold).toBe(0);
    expect(update({ lowStockThreshold: '0' }).dto.lowStockThreshold).toBe(0);
  });

  it('refus : types et valeurs invalides', () => {
    for (const body of [
      { lowStockThreshold: -3 },
      { lowStockThreshold: true },
      { lowStockThreshold: [5] },
      { expiryDate: 20261017 },
      { expiryDate: '2026-10-17T00:00:00.000Z' },
    ]) {
      expect(update(body).errors.length).toBeGreaterThan(0);
    }
  });
});
