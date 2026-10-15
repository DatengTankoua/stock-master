/**
 * Lot 1-23A — Catalogue FICTIF de RoyalVibe Cosmétique (démonstration).
 *
 * Prix en FCFA (entiers), contenance dans le nom (le produit n'a pas de
 * champ dédié). `photo` : fichier de `media/photos/` (inventaire et
 * licences : `media/MEDIA-INVENTORY.md`). `weight` : popularité relative
 * utilisée par le générateur de ventes ; `floor` : stock minimal laissé par
 * l'historique (0 autorisé = rupture possible).
 */
'use strict';

const SECTIONS = Object.freeze([
  {
    key: 'laits',
    name: 'Laits corporels',
    description: 'Laits de toilette et laits pour le corps',
  },
  {
    key: 'gels',
    name: 'Gels douche et savons',
    description: 'Gels douche, savons solides et liquides',
  },
  {
    key: 'visage',
    name: 'Soins du visage',
    description: 'Crèmes, sérums et masques',
  },
  {
    key: 'huiles',
    name: 'Huiles corporelles',
    description: 'Huiles végétales pour le corps et les cheveux',
  },
  {
    key: 'cheveux',
    name: 'Soins capillaires',
    description: 'Shampoings, après-shampoings et soins',
  },
]);

// prettier-ignore
const PRODUCTS = Object.freeze([
  // Laits corporels
  { key: 'lait-karite', section: 'laits', name: 'Lait corporel karité 400 ml', purchase: 2300, sale: 3500, qty: 36, weight: 9, photo: 'lait-karite.jpg' },
  { key: 'lait-aloe', section: 'laits', name: 'Lait de toilette aloe vera 250 ml', purchase: 1600, sale: 2500, qty: 30, weight: 6, photo: 'lait-aloe.jpg' },
  { key: 'lait-cacao', section: 'laits', name: 'Lait hydratant beurre de cacao 400 ml', purchase: 2400, sale: 3600, qty: 28, weight: 6, photo: 'lait-cacao.jpg' },
  { key: 'lait-coco', section: 'laits', name: 'Lait corporel coco 250 ml', purchase: 1500, sale: 2300, qty: 30, weight: 5, photo: 'lait-coco.jpg' },
  { key: 'lait-familial', section: 'laits', name: 'Lait de toilette nourrissant 1 L', purchase: 4000, sale: 6000, qty: 16, weight: 3, photo: 'lait-familial.jpg' },
  // Gels douche et savons
  { key: 'gel-citron', section: 'gels', name: 'Gel douche fraîcheur citron 500 ml', purchase: 1800, sale: 2800, qty: 30, weight: 6, photo: 'gel-citron.jpg' },
  { key: 'gel-aloe', section: 'gels', name: 'Gel douche aloe vera 750 ml', purchase: 2400, sale: 3700, qty: 24, weight: 4, photo: 'gel-aloe.jpg' },
  { key: 'savon-karite', section: 'gels', name: 'Savon au karité 200 g', purchase: 450, sale: 800, qty: 60, weight: 9, photo: 'savon-karite.jpg' },
  { key: 'savon-noir', section: 'gels', name: 'Savon noir artisanal 250 g', purchase: 700, sale: 1200, qty: 48, weight: 7, photo: 'savon-noir.jpg' },
  { key: 'savon-liquide', section: 'gels', name: 'Savon liquide mains 300 ml', purchase: 1200, sale: 1900, qty: 20, weight: 3, photo: 'savon-liquide.jpg' },
  // Soins du visage
  { key: 'creme-jour', section: 'visage', name: 'Crème de jour hydratante 50 ml', purchase: 3500, sale: 5500, qty: 18, weight: 4, photo: 'creme-jour.jpg' },
  { key: 'creme-nuit', section: 'visage', name: 'Crème de nuit réparatrice 50 ml', purchase: 4000, sale: 6500, qty: 14, weight: 3, photo: 'creme-nuit.jpg' },
  { key: 'serum-c', section: 'visage', name: 'Sérum vitamine C 30 ml', purchase: 4500, sale: 7500, qty: 12, weight: 3, photo: 'serum-c.jpg' },
  { key: 'gommage', section: 'visage', name: 'Gommage visage doux 100 ml', purchase: 2200, sale: 3500, qty: 16, weight: 2, photo: 'gommage.jpg' },
  { key: 'masque-argile', section: 'visage', name: 'Masque purifiant à l’argile 100 g', purchase: 2000, sale: 3200, qty: 15, weight: 2, photo: 'masque-argile.jpg' },
  // Huiles corporelles
  { key: 'huile-coco', section: 'huiles', name: 'Huile de coco vierge 250 ml', purchase: 1800, sale: 3000, qty: 24, weight: 5, photo: 'huile-coco.jpg' },
  { key: 'huile-karite', section: 'huiles', name: 'Huile de karité 100 ml', purchase: 1500, sale: 2500, qty: 20, weight: 4, photo: 'huile-karite.jpg' },
  { key: 'huile-ricin', section: 'huiles', name: 'Huile de ricin 100 ml', purchase: 1400, sale: 2300, qty: 22, weight: 4, photo: 'huile-ricin.jpg' },
  { key: 'huile-argan', section: 'huiles', name: 'Huile d’argan 50 ml', purchase: 3800, sale: 6000, qty: 10, weight: 4, floor: 1, photo: 'huile-argan.jpg' },
  // Soins capillaires
  { key: 'shampoing', section: 'cheveux', name: 'Shampoing nourrissant karité 400 ml', purchase: 2000, sale: 3200, qty: 24, weight: 5, photo: 'shampoing.jpg' },
  { key: 'apres-shampoing', section: 'cheveux', name: 'Après-shampoing démêlant 400 ml', purchase: 2100, sale: 3300, qty: 18, weight: 3, photo: 'apres-shampoing.jpg' },
  { key: 'masque-avocat', section: 'cheveux', name: 'Masque capillaire avocat 300 ml', purchase: 2800, sale: 4500, qty: 14, weight: 2, photo: 'masque-avocat.jpg' },
  { key: 'creme-coiffante', section: 'cheveux', name: 'Crème coiffante hydratante 250 ml', purchase: 1900, sale: 3000, qty: 20, weight: 3, photo: 'creme-coiffante.jpg' },
  { key: 'lait-capillaire', section: 'cheveux', name: 'Lait capillaire hydratant 250 ml', purchase: 1700, sale: 2700, qty: 18, weight: 2, photo: 'lait-capillaire.jpg' },
]);

/**
 * Droits SUPPLÉMENTAIRES des vendeurs (catalogue de permissions 2), en plus
 * des droits du rôle vendeur (enregistrer une vente, voir ses ventes).
 */
const SELLER_PERMISSIONS = Object.freeze({
  // Junior : ajuste le stock et voit le stock restant.
  sellerStock: ['stock.adjust', 'products.view_stock_details'],
  // Grâce : droits du rôle seulement.
  sellerBasic: [],
});

/** Couleur de RoyalVibe (vert des feuilles du logo), `#RRGGBB`. */
const BRAND_COLOR = '#1E5B3A';

module.exports = { SECTIONS, PRODUCTS, SELLER_PERMISSIONS, BRAND_COLOR };
