import {
  REPORT_GENERATION_BUSY,
  REPORT_GENERATION_LIMITS,
  REPORT_RATE_LIMITED,
  REPORT_REQUESTS_LIMITED,
  ReportGenerationLimiter,
  reportCost,
  type ReportGenerationDecision,
  type ReportRequestDecision,
} from './report-generation-limiter';

const limits = {
  windowMs: 60_000,
  maxRequestsPerWindow: 5,
  maxCountingGlobal: 2,
  maxCountingPerOrganization: 1,
  maxPerWindow: 3,
  maxActiveGlobal: 2,
  maxActivePerOrganization: 1,
  busyRetryAfterSeconds: 7,
  maxRows: { xlsx: 100, pdf: 25 },
  rowCost: { xlsx: 1, pdf: 4 },
  maxActiveCost: 150,
};

function admitted(
  d: ReportGenerationDecision | ReportRequestDecision,
): () => void {
  if (!d.admitted) throw new Error(`refusé : ${d.code}`);
  return d.release;
}

describe('1-16D — limiteur de génération des historiques', () => {
  let now = 0;
  const limiter = () => new ReportGenerationLimiter(limits, () => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it('paramètres de production centralisés et figés', () => {
    expect(Object.isFrozen(REPORT_GENERATION_LIMITS)).toBe(true);
    expect(
      REPORT_GENERATION_LIMITS.maxActivePerOrganization,
    ).toBeGreaterThanOrEqual(2); // Excel + PDF
    expect(new ReportGenerationLimiter().active).toBe(0);
  });

  it('quota par compte et commerce : 429 avec délai exact, puis réouverture', () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) admitted(l.acquire('u1', 'o1', 1))();
    now += 20_000;
    expect(l.acquire('u1', 'o1', 1)).toEqual({
      admitted: false,
      code: REPORT_RATE_LIMITED,
      retryAfterSeconds: 40,
    });
    // Autre compte, ou même compte dans un autre commerce : indépendants.
    admitted(l.acquire('u2', 'o1', 1))();
    admitted(l.acquire('u1', 'o2', 1))();
    now += 40_000;
    admitted(l.acquire('u1', 'o1', 1))();
  });

  it('simultanéité : 503 sans consommer le quota ; place rendue à la libération', () => {
    const l = limiter();
    const release = admitted(l.acquire('u1', 'o1', 1));
    expect(l.acquire('u2', 'o1', 1)).toEqual({
      admitted: false,
      code: REPORT_GENERATION_BUSY,
      retryAfterSeconds: 7,
    });
    const other = admitted(l.acquire('u3', 'o2', 1));
    expect(l.acquire('u4', 'o3', 1)).toMatchObject({
      code: REPORT_GENERATION_BUSY,
    });
    expect(l.active).toBe(2);
    release();
    release(); // idempotent
    other();
    expect(l.active).toBe(0);
    // Les refus de simultanéité n'ont rien consommé : u2 a encore 3 essais.
    for (let i = 0; i < 3; i++) admitted(l.acquire('u2', 'o1', 1))();
    expect(l.acquire('u2', 'o1', 1)).toMatchObject({
      code: REPORT_RATE_LIMITED,
    });
  });

  it('1-22E : plafonds par format cohérents avec le budget global', () => {
    const p = REPORT_GENERATION_LIMITS;
    expect(Object.isFrozen(p.maxRows)).toBe(true);
    // Le PDF coûte plus par ligne : plafond plus bas que l'Excel.
    expect(p.maxRows.pdf).toBeLessThan(p.maxRows.xlsx);
    // Un export au plafond est toujours admissible seul.
    for (const format of ['xlsx', 'pdf'] as const) {
      expect(reportCost(p, format, p.maxRows[format])).toBeLessThanOrEqual(
        p.maxActiveCost,
      );
    }
    // Mois vide : coût minimal non nul.
    expect(reportCost(p, 'xlsx', 0)).toBe(1);
  });

  it('1-22E : capacité globale en coût, indépendante du nombre de commerces', () => {
    const l = limiter();
    // PDF au plafond (25 × 4 = 100) dans o1.
    const big = admitted(l.acquire('u1', 'o1', reportCost(limits, 'pdf', 25)));
    // Un second gros export d'un AUTRE commerce dépasse le budget (150) :
    // refus temporaire, sans consommer le quota.
    expect(
      l.acquire('u2', 'o2', reportCost(limits, 'xlsx', 100)),
    ).toMatchObject({ code: REPORT_GENERATION_BUSY, retryAfterSeconds: 7 });
    // Un petit export tient dans le reste du budget.
    const small = admitted(l.acquire('u3', 'o3', 40));
    expect(l.activeCostTotal).toBe(140);
    big();
    small();
    expect(l.activeCostTotal).toBe(0);
    admitted(l.acquire('u2', 'o2', reportCost(limits, 'xlsx', 100)))();
  });

  it('libération après erreur (bloc finally)', () => {
    const l = limiter();
    const run = () => {
      const slot = l.acquire('u1', 'o1', 1);
      try {
        throw new Error('échec de génération');
      } finally {
        if (slot.admitted) slot.release();
      }
    };
    expect(run).toThrow('échec de génération');
    expect(l.active).toBe(0);
    expect(l.activeCostTotal).toBe(0);
    admitted(l.acquire('u1', 'o1', 1))();
  });

  it('1-22E : admission des demandes avant comptage, distincte du quota de génération', () => {
    const l = limiter();
    // Comptages simultanés : 1 par commerce, 2 au total ; refus sans
    // consommer le quota de demandes.
    const c1 = admitted(l.admitRequest('u1', 'o1'));
    expect(l.admitRequest('u2', 'o1')).toEqual({
      admitted: false,
      code: REPORT_GENERATION_BUSY,
      retryAfterSeconds: 7,
    });
    const c2 = admitted(l.admitRequest('u3', 'o2'));
    expect(l.admitRequest('u4', 'o3')).toMatchObject({
      code: REPORT_GENERATION_BUSY,
    });
    expect(l.counting).toBe(2);
    c1();
    c1(); // idempotent
    c2();
    expect(l.counting).toBe(0);

    // Demandes répétées (refusées en 422, sans génération) : quota de
    // demandes épuisé après 5, avec délai exact ; génération intacte.
    for (let i = 0; i < 4; i++) admitted(l.admitRequest('u1', 'o1'))();
    now += 15_000;
    expect(l.admitRequest('u1', 'o1')).toEqual({
      admitted: false,
      code: REPORT_REQUESTS_LIMITED,
      retryAfterSeconds: 45,
    });
    admitted(l.admitRequest('u1', 'o2'))();
    admitted(l.acquire('u1', 'o1', 1))();
    now += 45_000;
    admitted(l.admitRequest('u1', 'o1'))();
  });

  it('1-22E : ajustement du coût réservé — atomique, refusé au-delà du budget', () => {
    const l = limiter();
    const a = l.acquire('u1', 'o1', 40);
    const b = l.acquire('u2', 'o2', 40);
    if (!a.admitted || !b.admitted) throw new Error('refusé');
    // 40 → 100 : 140 ≤ 150.
    expect(a.resize(100)).toBe(true);
    expect(l.activeCostTotal).toBe(140);
    // b : 40 → 60 dépasserait (160) : refus, réservation inchangée.
    expect(b.resize(60)).toBe(false);
    expect(l.activeCostTotal).toBe(140);
    // Baisse toujours admise.
    expect(b.resize(10)).toBe(true);
    a.release();
    b.release();
    expect(l.activeCostTotal).toBe(0);
    // Après libération, plus d'ajustement possible.
    expect(a.resize(1)).toBe(false);
    expect(l.activeCostTotal).toBe(0);
  });
});
