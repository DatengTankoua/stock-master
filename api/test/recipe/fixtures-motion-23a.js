/**
 * 1-23A — Comptes FICTIFS de la démonstration du film (profil `motion-23a`).
 * Domaine réservé `example.test` ; mot de passe commun : `PASSWORD` de
 * `recipe-common.js`. Créés par les SERVICES RÉELS (`seed-fixtures.js`) :
 * inscription du propriétaire, puis invitations acceptées.
 *
 * Droits des vendeurs : appliqués ensuite par l'API (seed de démonstration,
 * `marketing/stock-master-motion/demo/seed-royalvibe.js`).
 */
'use strict';

const ACCOUNTS = Object.freeze([
  {
    key: 'owner',
    email: 'mireille@royalvibe.example.test',
    name: 'Mireille Ngo Bayiha',
    organization: 'RoyalVibe Cosmétique',
    role: 'owner',
    use: 'Propriétaire de RoyalVibe Cosmétique',
  },
  {
    key: 'admin',
    email: 'aicha@royalvibe.example.test',
    name: 'Aïcha Mbarga',
    invitedBy: 'owner',
    role: 'admin',
    use: 'Administratrice',
  },
  {
    key: 'sellerStock',
    email: 'junior@royalvibe.example.test',
    name: 'Junior Tchoumi',
    invitedBy: 'owner',
    role: 'seller',
    use: 'Vendeur : ventes + ajuster le stock + voir le stock',
  },
  {
    key: 'sellerBasic',
    email: 'grace@royalvibe.example.test',
    name: 'Grâce Ewane',
    invitedBy: 'owner',
    role: 'seller',
    use: 'Vendeuse : ventes et ses propres ventes',
  },
]);

for (const account of ACCOUNTS) {
  if (
    account.name.length > 20 ||
    (account.organization && account.organization.length > 20)
  ) {
    throw new Error(`Fixture invalide : ${account.key}`);
  }
}

module.exports = { ACCOUNTS };
