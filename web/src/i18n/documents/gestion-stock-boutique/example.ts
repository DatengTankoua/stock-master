// Guide « gestion du stock » — exemples PÉDAGOGIQUES et FICTIFS, communs
// aux deux langues : ils ne décrivent la situation d'aucun client. Les
// valeurs dérivées sont calculées ici, jamais recopiées dans le texte.

const opening = 20;
const received = 10;
const sold = 8;
const damaged = 1;
const unitPriceXaf = 3500;

export const STOCK_EXAMPLE = Object.freeze({
  opening,
  received,
  sold,
  damaged,
  unitPriceXaf,
  afterReceipt: opening + received,
  afterSales: opening + received - sold,
  remaining: opening + received - sold - damaged,
  /** Chiffre d'affaires des ventes : ni un bénéfice, ni un encaissement. */
  revenueXaf: sold * unitPriceXaf,
});

const dailySales = 2;
const supplierDelayDays = 3;
const safetyDays = 2;

/** Seuil de commande = ventes par jour × (délai fournisseur + marge). */
export const REORDER_EXAMPLE = Object.freeze({
  dailySales,
  supplierDelayDays,
  safetyDays,
  reorderPoint: dailySales * (supplierDelayDays + safetyDays),
});
