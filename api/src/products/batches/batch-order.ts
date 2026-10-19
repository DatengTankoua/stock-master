import type { Types } from 'mongoose';
import type { ProductBatch } from './schemas/product-batch.schema';

/**
 * FEFO déterministe : péremption (inconnue en dernier), puis réception
 * (inconnue en dernier), puis référence, puis identifiant.
 */
export function compareFefo(
  a: Pick<ProductBatch, 'expiryDate' | 'receivedOn' | 'reference'> & {
    _id: Types.ObjectId;
  },
  b: Pick<ProductBatch, 'expiryDate' | 'receivedOn' | 'reference'> & {
    _id: Types.ObjectId;
  },
): number {
  const key = (v: string | null | undefined) => v ?? '9999-12-31';
  const pairs: [string, string][] = [
    [key(a.expiryDate), key(b.expiryDate)],
    [key(a.receivedOn), key(b.receivedOn)],
    [a.reference, b.reference],
    [a._id.toHexString(), b._id.toHexString()],
  ];
  for (const [x, y] of pairs) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
