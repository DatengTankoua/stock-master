// 1-21D — Capacité incluse : plafond de fiches produit conservées par
// organisation. AUCUNE valeur ici : réexport du module SERVEUR, importé au
// build (même procédé que les tarifs). L'écran du catalogue lit, lui, le
// total et le plafond sur l'API (`GET /products/capacity`).
export { PRODUCT_CAPACITY } from "../../../api/src/products/product-capacity";
