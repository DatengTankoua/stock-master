import {
  addCivilDays,
  dueExpiryAlert,
  expiryAlertEventKey,
  nextExpiryAlertOn,
  normalizeLeadDays,
} from './expiry-alerts';
import { businessDate } from '../batches/business-date';
import { PERMISSION_CATALOGS } from '../../organizations/permissions';

describe('lot C — alertes de péremption (règles pures)', () => {
  it('dates civiles : passages de mois et d’année, années bissextiles', () => {
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCivilDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addCivilDays('2026-10-19', -30)).toBe('2026-09-19');
  });

  it('délai : entier 0 à 365, 30 par défaut ; 0 n’est pas une désactivation', () => {
    expect(normalizeLeadDays(undefined)).toBe(30);
    expect(normalizeLeadDays(0)).toBe(0);
    expect(normalizeLeadDays(365)).toBe(365);
    expect(normalizeLeadDays(366)).toBe(30);
    expect(normalizeLeadDays(2.5)).toBe(30);
    // Délai 0 : alerte le jour même de l'échéance.
    expect(dueExpiryAlert('2026-10-19', '2026-10-19', 0, null)?.stage).toBe(
      'soon',
    );
  });

  it('échéance aujourd’hui, demain, dépassée, sans date (délai 1 jour)', () => {
    const today = '2026-10-19';
    expect(dueExpiryAlert(today, today, 1, null)?.stage).toBe('soon');
    expect(dueExpiryAlert('2026-10-20', today, 1, null)?.stage).toBe('soon');
    expect(dueExpiryAlert('2026-10-21', today, 1, null)).toBeNull();
    expect(dueExpiryAlert('2026-10-18', today, 1, null)?.stage).toBe('expired');
    expect(dueExpiryAlert(null, today, 1, null)).toBeNull();
  });

  it('découvert déjà dépassé : seulement « périmé » ; aucune répétition', () => {
    const due = dueExpiryAlert('2026-10-10', '2026-10-19', 30, null)!;
    expect(due.stage).toBe('expired');
    expect(due.marks).toEqual({ expiredFor: '2026-10-10' });
    expect(due.nextOn).toBeNull();
    expect(
      dueExpiryAlert('2026-10-10', '2026-10-20', 30, due.marks),
    ).toBeNull();
  });

  it('« bientôt » puis « périmé » une seule fois chacun, planification exacte', () => {
    const soon = dueExpiryAlert('2026-10-25', '2026-10-19', 30, null)!;
    expect(soon.stage).toBe('soon');
    expect(soon.nextOn).toBe('2026-10-26');
    expect(
      dueExpiryAlert('2026-10-25', '2026-10-24', 30, soon.marks),
    ).toBeNull();
    const expired = dueExpiryAlert('2026-10-25', '2026-10-26', 30, soon.marks)!;
    expect(expired.stage).toBe('expired');
    expect(expired.marks).toEqual({
      soonFor: '2026-10-25',
      expiredFor: '2026-10-25',
    });
  });

  it('changement de date : nouvelle échéance réarmée ; retour à une date annoncée : rien', () => {
    const marks = { soonFor: '2026-10-25' };
    expect(nextExpiryAlertOn('2026-12-01', 30, marks)).toBe('2026-11-01');
    expect(nextExpiryAlertOn('2026-10-25', 30, marks)).toBe('2026-10-26');
    expect(
      nextExpiryAlertOn('2026-10-25', 30, {
        soonFor: '2026-10-25',
        expiredFor: '2026-10-25',
      }),
    ).toBeNull();
    expect(nextExpiryAlertOn(null, 30, marks)).toBeNull();
  });

  it('changement de délai : pas de réarmement d’une étape annoncée', () => {
    const marks = { soonFor: '2026-11-30' };
    expect(nextExpiryAlertOn('2026-11-30', 60, marks)).toBe('2026-12-01');
    expect(nextExpiryAlertOn('2026-11-30', 60, null)).toBe('2026-10-01');
  });

  it('clé de déduplication : cible, échéance et étape', () => {
    expect(
      expiryAlertEventKey('soon', { kind: 'batch', id: 'b1' }, '2026-10-25'),
    ).toBe('expiry-soon:batch:b1:2026-10-25');
    expect(
      expiryAlertEventKey(
        'expired',
        { kind: 'product', id: 'p1' },
        '2026-10-25',
      ),
    ).toBe('expiry-expired:product:p1:2026-10-25');
  });

  it('changement de jour selon le fuseau du commerce, jamais celui de l’appareil', () => {
    const lateEvening = new Date('2026-10-25T23:30:00Z');
    // Douala (UTC+1) : déjà le 26 → un lot du 25 est dépassé.
    const douala = businessDate(lateEvening, 'Africa/Douala');
    expect(
      dueExpiryAlert('2026-10-25', douala, 30, { soonFor: '2026-10-25' })
        ?.stage,
    ).toBe('expired');
    // Fuseau UTC−12 : encore le 25 → toujours valide.
    const west = businessDate(lateEvening, 'Etc/GMT+12');
    expect(
      dueExpiryAlert('2026-10-25', west, 30, { soonFor: '2026-10-25' }),
    ).toBeNull();
  });
});

describe('lot C — catalogues de permissions par combinaison affichée', () => {
  it('5 : alertes seules ; 6 : lots seuls ; 7 : tout ; 4 (web des lots A/B) sans lot C', () => {
    expect(PERMISSION_CATALOGS[5]).toContain('products.manage_expiry_alerts');
    expect(PERMISSION_CATALOGS[5]).not.toContain('stock.manage_batches');
    expect(PERMISSION_CATALOGS[5]).not.toContain('stock.record_losses');
    expect(PERMISSION_CATALOGS[6]).toContain('stock.quarantine_batches');
    expect(PERMISSION_CATALOGS[6]).toContain('stock.record_losses');
    expect(PERMISSION_CATALOGS[6]).not.toContain(
      'products.manage_expiry_alerts',
    );
    expect(PERMISSION_CATALOGS[7]).toContain('stock.record_losses');
    expect(PERMISSION_CATALOGS[7]).toContain('products.manage_expiry_alerts');
    expect(PERMISSION_CATALOGS[4]).toContain('stock.manage_batches');
    expect(PERMISSION_CATALOGS[4]).not.toContain('stock.record_losses');
    expect(PERMISSION_CATALOGS[3]).not.toContain(
      'products.manage_expiry_alerts',
    );
  });
});
