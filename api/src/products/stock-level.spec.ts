import { isLowStock, stockAlertFor, stockStatus } from './stock-level';

const level = (
  initialQuantity: number,
  remainingQuantity: number,
  lowStockThreshold?: number | null,
) => ({ initialQuantity, remainingQuantity, lowStockThreshold });

describe('stock-level — règle centrale du stock faible', () => {
  it('sans seuil : règle par défaut existante (80 % consommés, base = quantité initiale ajouts compris)', () => {
    expect(isLowStock(level(100, 21))).toBe(false);
    expect(isLowStock(level(100, 20))).toBe(true);
    expect(isLowStock(level(100, 20, null))).toBe(true);
    // Après un ajout de 100 (initial 200) : 40 restants = 20 %.
    expect(isLowStock(level(200, 41))).toBe(false);
    expect(isLowStock(level(200, 40))).toBe(true);
    // Quantité initiale nulle (donnée historique) : jamais faible.
    expect(isLowStock(level(0, 5))).toBe(false);
  });

  it('seuil personnalisé : strictement inférieur (au-dessus, au seuil, en dessous)', () => {
    expect(isLowStock(level(100, 6, 5))).toBe(false);
    expect(isLowStock(level(100, 5, 5))).toBe(false);
    expect(isLowStock(level(100, 4, 5))).toBe(true);
  });

  it('seuil 0 explicite : jamais faible ; seuil invalide (négatif, NaN) : règle par défaut', () => {
    expect(isLowStock(level(100, 1, 0))).toBe(false);
    expect(stockStatus(level(100, 0, 0))).toBe('out_of_stock');
    expect(isLowStock(level(100, 20, -1))).toBe(true);
    expect(isLowStock(level(100, 20, Number.NaN))).toBe(true);
  });

  it('rupture prioritaire sur le stock faible', () => {
    expect(stockStatus(level(100, 0))).toBe('out_of_stock');
    expect(stockStatus(level(100, 0, 50))).toBe('out_of_stock');
    expect(stockStatus(level(100, 3, 5))).toBe('low_stock');
    expect(stockStatus(level(100, 5, 5))).toBe('in_stock');
  });
});

describe('stockAlertFor — une alerte à l’entrée, jamais de répétition', () => {
  it('vente qui fait passer sous le seuil : `low` ; vente suivante sous le seuil : rien', () => {
    expect(stockAlertFor(level(100, 5, 5), level(100, 4, 5))).toBe('low');
    expect(stockAlertFor(level(100, 4, 5), level(100, 3, 5))).toBeNull();
  });

  it('arrivée exactement au seuil : pas encore faible', () => {
    expect(stockAlertFor(level(100, 6, 5), level(100, 5, 5))).toBeNull();
  });

  it('rupture directe : `depleted` seul (jamais deux alertes)', () => {
    expect(stockAlertFor(level(100, 6, 5), level(100, 0, 5))).toBe('depleted');
    expect(stockAlertFor(level(100, 3, 5), level(100, 0, 5))).toBe('depleted');
    expect(stockAlertFor(level(100, 0, 5), level(100, 0, 5))).toBeNull();
  });

  it('réapprovisionnement au-dessus du seuil puis nouvelle baisse : nouvelle alerte', () => {
    expect(stockAlertFor(level(100, 3, 5), level(110, 13, 5))).toBeNull();
    expect(stockAlertFor(level(110, 13, 5), level(110, 4, 5))).toBe('low');
  });

  it('changement de seuil : alerte seulement à l’entrée, jamais en restant ni en sortant', () => {
    // Entrée : 8 restants, seuil 5 → 10.
    expect(stockAlertFor(level(100, 8, 5), level(100, 8, 10))).toBe('low');
    // Déjà faible et toujours faible (10 → 12) : rien.
    expect(stockAlertFor(level(100, 8, 10), level(100, 8, 12))).toBeNull();
    // Sortie (12 → 0) : rien, réarmé.
    expect(stockAlertFor(level(100, 8, 12), level(100, 8, 0))).toBeNull();
    // Retour à la règle par défaut qui rend faible (8 ≤ 20 % de 100).
    expect(stockAlertFor(level(100, 8, 5), level(100, 8, null))).toBe('low');
    // Même valeur : jamais d'alerte.
    expect(stockAlertFor(level(100, 8, 10), level(100, 8, 10))).toBeNull();
  });

  it('règle par défaut inchangée (cas 1-16A.1 : 21 → 20 sur 100)', () => {
    expect(stockAlertFor(level(100, 21), level(100, 20))).toBe('low');
    expect(stockAlertFor(level(100, 20), level(100, 19))).toBeNull();
  });
});
