import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateTaxSummary, defaultTaxSettings } from "./tax.ts";

describe("calculateTaxSummary", () => {
  it("preserva il calcolo fiscale e distingue incassato e da incassare", () => {
    const result = calculateTaxSummary(
      [
        { lordo: 10_000, netto: 9_000, enasarco: 1_000, incassata: true },
        { lordo: 5_000, netto: 4_500, enasarco: 500, incassata: false },
      ],
      [{ anno: 2026, descrizione: "Acconto", importo: 1_000, tipo: "F24" }],
      {
        anno: 2026,
        aliquota_imposta: 15,
        coefficiente_redditivita: 78,
        aliquota_inps: 24,
        minimale_inps: 10_000,
      },
    );

    assert.equal(result.fatturato, 15_000);
    assert.equal(result.netto, 13_500);
    assert.equal(result.enasarco, 1_500);
    assert.equal(result.incassato, 9_000);
    assert.equal(result.daIncassare, 4_500);
    assert.equal(result.imponibile, 11_700);
    assert.equal(result.imposta, 1_755);
    assert.equal(result.inps, 2_808);
    assert.equal(result.tasseTotali, 4_563);
    assert.equal(result.residuo, 3_563);
    assert.equal(result.disponibilitaStimata, 4_437);
  });

  it("mantiene le impostazioni predefinite storiche", () => {
    assert.equal(defaultTaxSettings(2025).aliquota_imposta, 5);
    assert.equal(defaultTaxSettings(2026).aliquota_imposta, 15);
  });
});
