
const COMMISSIONE_BPS = 1500;

export function calcolaCompetenze(importoEuro) {
  const importo = Number(importoEuro);

  if (!Number.isFinite(importo) || importo <= 0) {
    throw new Error('Importo incassato non valido');
  }

  const centesimi = Math.round(importo * 100);

  if (!Number.isSafeInteger(centesimi) || centesimi <= 0) {
    throw new Error('Importo in centesimi non valido');
  }

  const commissione = Math.round(
    centesimi * COMMISSIONE_BPS / 10000
  );

  const guadagno = centesimi - commissione;

  return {
    commissione: commissione / 100,
    guadagno_autista: guadagno / 100
  };
}

export async function contabilizzaPagamento(client, pagamentoId) {
  const { rows } = await client.query(
    `SELECT id, importo, stato, commissione, guadagno_autista
     FROM public.pagamenti
     WHERE id = $1
     FOR UPDATE`,
    [pagamentoId]
  );

  if (rows.length !== 1) {
    throw new Error(`Pagamento ${pagamentoId} non trovato`);
  }

  const pagamento = rows[0];

  if (pagamento.stato !== 'pagato') {
    throw new Error(
      `Pagamento ${pagamentoId} non acquisito`
    );
  }

  const competenze = calcolaCompetenze(pagamento.importo);

  const commissioneAttuale = Number(pagamento.commissione ?? 0);
  const guadagnoAttuale = Number(pagamento.guadagno_autista ?? 0);

  if (
    commissioneAttuale !== 0 ||
    guadagnoAttuale !== 0
  ) {
    if (
      Math.round(commissioneAttuale * 100) !==
        Math.round(competenze.commissione * 100) ||
      Math.round(guadagnoAttuale * 100) !==
        Math.round(competenze.guadagno_autista * 100)
    ) {
      throw new Error(
        `Pagamento ${pagamentoId}: competenze già presenti ma incoerenti`
      );
    }

    return competenze;
  }

  await client.query(
    `UPDATE public.pagamenti
     SET commissione = $1,
         guadagno_autista = $2
     WHERE id = $3
       AND stato = 'pagato'`,
    [
      competenze.commissione,
      competenze.guadagno_autista,
      pagamentoId
    ]
  );

  return competenze;
}
